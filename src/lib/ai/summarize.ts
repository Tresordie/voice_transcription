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

/** 总结输出语言可选值（世界常用语言；'' = 跟随原文，不注入语言指令） */
export const OUTPUT_LANGUAGES: { value: string; label: string }[] = [
  { value: '', label: '跟随原文' },
  { value: '简体中文', label: '简体中文' },
  { value: '繁體中文', label: '繁體中文' },
  { value: 'English（英语）', label: 'English（英语）' },
  { value: '日本語（日语）', label: '日本語（日语）' },
  { value: '한국어（韩语）', label: '한국어（韩语）' },
  { value: 'Français（法语）', label: 'Français（法语）' },
  { value: 'Deutsch（德语）', label: 'Deutsch（德语）' },
  { value: 'Español（西班牙语）', label: 'Español（西班牙语）' },
  { value: 'Português（葡萄牙语）', label: 'Português（葡萄牙语）' },
  { value: 'Italiano（意大利语）', label: 'Italiano（意大利语）' },
  { value: 'Русский（俄语）', label: 'Русский（俄语）' },
  { value: 'العربية（阿拉伯语）', label: 'العربية（阿拉伯语）' },
  { value: 'हिन्दी（印地语）', label: 'हिन्दी（印地语）' },
  { value: 'ไทย（泰语）', label: 'ไทย（泰语）' },
  { value: 'Tiếng Việt（越南语）', label: 'Tiếng Việt（越南语）' },
  { value: 'Bahasa Indonesia（印尼语）', label: 'Bahasa Indonesia（印尼语）' },
]

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
function buildSystemPrompt(template: SummaryTemplate | null, userPrompt: string, language?: string): string {
  // 输出语言指令放在末尾（模板与 G-SPEC 之后），优先级最高。
  // 泛泛的"格式不得省略"约束不住语言切换时的契约衰减——这里把 G-SPEC 的结构要求
  // 逐条重述成清单，让模型在输出位置可逐项对照。
  const langNote = language
    ? `

【输出语言】请将总结的全部内容一律用「${language}」书写；这只是语言切换，结构与格式必须和中文输出完全一致，逐项对照以下清单（与上文 G-SPEC 契约对应，一项不得省略）：
① 结论式标题（含数字/对比）＋ 30秒 TL;DR（≤3条）；
② 模块化正文（小标题＋表格），每个模块末尾固定三行小结——用「${language}」等义标记（英文如 Key points / Conclusion / Next actions）；
③ 全局待办表：事项/唯一负责人/截止日/验收标准/出处 五列齐全；
④ 按内容自动配图：占比→饼图（≤5类）/堆叠条形（>5类）、排名→横向条形、趋势→折线（标异常点）、流程/依赖→mermaid flowchart、结构/聚类→mermaid mindmap、对比/参数→表格、时间/里程碑→时间轴/甘特、风险→概率×影响矩阵、状态→徽章/看板/进度条；每模块配 1 个图标，关键概念配 SVG 示意图；
⑤ 会议/线程/项目输出「时间戳|发言人/来源|事件」时间轴，关键摘录保留原话±2句＋时间戳（原话保留原语言）；
⑥ 封面块（SVG 封面：标题/日期/参与人/一句话结论/状态徽章）；
⑦ 保真：数字/人名/日期/标识符（版本号/SN/字段名/错误码）原文保留，缺失信息用「${language}」等义占位标记（英文如 [TBC]），推断必须标注，不新增事实。
若使用模板，模板定义的全部模块（如决策日志、证据附录、风险矩阵）一个不少，仅将文字换成「${language}」；上文契约中的中文固定措辞（【重点】【结论】【待办】【待确认】【待补】等）一律改为「${language}」等义标记；除原文直接引用与专有名词外不得出现中文；若上文契约与语言要求冲突，以本要求为准。`
    : ''
  if (template) {
    // 模板提示词原样（含其自身的 {{...}} 输入声明与 G-SPEC 契约），追加主输入说明
    return (
      template.prompt +
      '\n\n【本任务说明】上文「输入：{{...}}」所指的主输入材料在用户消息中以「===== 全文内容 =====」分隔完整给出；' +
      '其余占位符上下文若用户消息未提供，请按全文内容合理推断，无法推断的' +
      // 指定了输出语言时不用中文占位标记，避免与文末语言指令冲突
      (language ? '用输出语言的等义占位标记标注' : '写【待确认】') +
      '。' +
      (userPrompt.trim() ? `\n\n【用户额外要求】${userPrompt.trim()}` : '') +
      langNote
    )
  }
  return (
    '你是专业的内容总结助手。请理解用户消息中「===== 全文内容 =====」之后的完整材料，' +
    '输出一份结构清晰的 Markdown 总结（结论先行、要点条目化、善用小标题与表格），保留数字与专有名词原样，' +
    '不新增事实；' +
    // 指定了输出语言时不用中文占位标记，避免与文末语言指令冲突
    (language
      ? '缺失信息用输出语言的等义占位标记标注（如英文写 [TBC]）。'
      : '缺失信息写【待确认】。') +
    (userPrompt.trim()
      ? `\n\n【用户额外要求】${userPrompt.trim()}`
      : '\n【用户额外要求】请给出全面而精炼的总结：核心结论、关键要点、重要数据与待办事项。') +
    `\n\n${G_SPEC}` +
    langNote
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
  /** 输出语言（'' 或缺省 = 跟随原文） */
  language?: string
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
    { role: 'system', content: buildSystemPrompt(opts.template ?? null, opts.userPrompt ?? '', opts.language) },
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
