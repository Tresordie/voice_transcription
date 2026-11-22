// AI 总结编排：全文 →（超长时 map-reduce 分块理解）→ 流式最终总结
// 模板提示词（含 G-SPEC 输出契约）作用于最终阶段——先理解全文，再按模板/提示词输出
import { chatLLM, type LlmConfig, type ChatMessage } from './llm'
import { G_SPEC, type SummaryTemplate } from './templates'

/** map 阶段每块目标字符数 */
const CHUNK_CHARS = 8000
/** 超过此字符数启用 map-reduce */
const MAP_THRESHOLD = 12000
/** map 阶段最大块数（超出则截断并注明，约 100 万字符上限） */
const MAX_CHUNKS = 120

const MAP_SYSTEM =
  '你是资料整理专家。以下是大文档的一个片段，请提取关键信息要点：' +
  '事实、数字、结论、决策、待办、人名/日期/专有名词等，条目化输出（Markdown 列表），' +
  '保留数字与专有名词原样，不臆造、不评价，≤400 字。'

/** 按行/段落边界分块（避免切断语句），单行超长硬切兜底 */
function splitByParagraphs(text: string, maxChars = CHUNK_CHARS): string[] {
  const chunks: string[] = []
  let buf = ''
  for (const line of text.split('\n')) {
    if (buf && buf.length + line.length + 1 > maxChars) {
      chunks.push(buf)
      buf = ''
    }
    buf += (buf ? '\n' : '') + line
    while (buf.length >= maxChars) {
      chunks.push(buf.slice(0, maxChars))
      buf = buf.slice(maxChars)
    }
  }
  if (buf.trim()) chunks.push(buf)
  return chunks
}

/** 组装最终阶段的 system 提示词（模板 or 自由总结），并说明主输入位置 */
function buildSystemPrompt(template: SummaryTemplate | null, userPrompt: string): string {
  if (template) {
    // 模板提示词原样（含其自身的 {{...}} 输入声明与 G-SPEC 契约），追加主输入说明
    return (
      template.prompt +
      '\n\n【本任务说明】上文「输入：{{...}}」所指的主输入材料在用户消息中以「===== 全文内容 =====」分隔完整给出；' +
      '其余占位符上下文若用户消息未提供，请按全文内容合理推断，无法推断的写【待确认】。' +
      (userPrompt.trim() ? `\n\n【用户额外要求】${userPrompt.trim()}` : '')
    )
  }
  return (
    '你是专业的内容总结助手。请理解用户消息中「===== 全文内容 =====」之后的完整材料，' +
    '输出一份结构清晰的 Markdown 总结（结论先行、要点条目化、善用小标题与表格），保留数字与专有名词原样，' +
    '不新增事实；缺失信息写【待确认】。' +
    (userPrompt.trim()
      ? `\n\n【用户额外要求】${userPrompt.trim()}`
      : '\n【用户额外要求】请给出全面而精炼的总结：核心结论、关键要点、重要数据与待办事项。') +
    `\n\n${G_SPEC}`
  )
}

/** 有并发上限的 map 执行器（保序输出） */
async function mapWithConcurrency(
  items: string[],
  limit: number,
  worker: (item: string, index: number) => Promise<string>,
  signal?: AbortSignal,
): Promise<string[]> {
  const results = new Array<string>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
      const i = next++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return results
}

export interface SummarizeOptions {
  /** 选中的模板（null = 自由总结） */
  template?: SummaryTemplate | null
  /** 用户自定义提示词（可与模板叠加） */
  userPrompt?: string
  /** 阶段进度：(说明, 已完成块数, 总块数)；单次直读时 total=0 */
  onProgress?: (stage: string, done: number, total: number) => void
  /** 最终阶段流式回调 */
  onDelta?: (delta: string, full: string) => void
  signal?: AbortSignal
}

/** 主入口：理解全文（超长 map-reduce）→ 按模板/提示词流式生成总结，返回完整 Markdown */
export async function summarizeContent(
  cfg: LlmConfig,
  content: string,
  opts: SummarizeOptions = {},
): Promise<string> {
  let material = content
  let truncatedNote = ''

  if (content.length > MAP_THRESHOLD) {
    let chunks = splitByParagraphs(content)
    if (chunks.length > MAX_CHUNKS) {
      chunks = chunks.slice(0, MAX_CHUNKS)
      truncatedNote = `\n\n> ⚠️ 原文约 ${Math.ceil(content.length / 10000)} 万字符，超出单次分析上限，本次仅分析前 ${MAX_CHUNKS} 个片段（约 ${Math.ceil((MAX_CHUNKS * CHUNK_CHARS) / 10000)} 万字符）。`
    }
    opts.onProgress?.('理解全文（分块提取要点）', 0, chunks.length)
    const bullets = await mapWithConcurrency(
      chunks,
      2,
      async (chunk, i) => {
        const out = await chatLLM(cfg, [
          { role: 'system', content: MAP_SYSTEM },
          { role: 'user', content: `【片段 ${i + 1}/${chunks.length}】\n${chunk}` },
        ], { maxTokens: 800, signal: opts.signal })
        opts.onProgress?.('理解全文（分块提取要点）', i + 1, chunks.length)
        return out
      },
      opts.signal,
    )
    material =
      '以下是对全文各片段依次提取的要点合集（已按原文顺序拼接），请在此基础上结合整体脉络进行总结：\n\n' +
      bullets.map((b, i) => `【片段 ${i + 1} 要点】\n${b}`).join('\n\n') +
      truncatedNote
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(opts.template ?? null, opts.userPrompt ?? '') },
    { role: 'user', content: `===== 全文内容 =====\n${material}` },
  ]
  opts.onProgress?.('生成总结', 0, 0)
  return chatLLM(cfg, messages, {
    stream: true,
    onDelta: opts.onDelta,
    signal: opts.signal,
    temperature: 0.3,
  })
}
