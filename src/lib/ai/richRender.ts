// 富渲染：marked 解析 + 特殊代码块升级（G-SPEC 契约的可视化输出）
//  - ```mermaid（或无语言但以 mermaid 图类型开头）→ mermaid 渲染为 SVG 图表
//  - ```svg（或无语言但以 <svg 开头）→ 内联为真实 SVG 图形
// 预览（MarkdownView）与导出（exporters html/pdf/doc）共用本管线，保证所见即所得导出
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { detectTimeline, renderTimelineHtml } from './timeline'

marked.setOptions({ async: false, gfm: true, breaks: false })

/** mermaid 图类型的起始关键字（无语言标注时的兜底识别） */
const MERMAID_START =
  /^(flowchart|graph|mindmap|gantt|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|journey|pie|gitGraph|quadDiagram|requirementDiagram|sankey-beta|xychart-beta|timeline|block-beta)\b/

/** 判断代码块是否为可渲染图形（svg / mermaid），返回类型。
 *  内容特征优先：以 <svg 开头必然是图形（模型常用 xml/html 围栏标注 SVG）；
 *  以 mermaid 图类型关键字开头必然是图。 */
export function detectFigure(lang: string, code: string): 'svg' | 'mermaid' | null {
  const trimmed = code.trim()
  if (/^<svg[\s>]/i.test(trimmed)) return 'svg'
  if (MERMAID_START.test(trimmed)) return 'mermaid'
  const l = lang.toLowerCase()
  if (l === 'svg') return 'svg'
  if (l === 'mermaid') return 'mermaid'
  return null
}

let mermaidMod: typeof import('mermaid') | null = null

/** mermaid 渲染为 SVG 字符串（失败抛错，由调用方降级保留源码） */
export async function renderMermaidToSvg(code: string, dark = false): Promise<string> {  if (!mermaidMod) {
    mermaidMod = await import('mermaid')
    try {
      // ELK 布局引擎：复杂流程图的正交边路由（更少的斜线长边与交叉），失败回落默认 dagre
      const elk = await import('@mermaid-js/layout-elk')
      mermaidMod.default.registerLayoutLoaders(elk.default)
    } catch {
      // 忽略
    }
  }
  const mermaid = mermaidMod.default
  // defaultRenderer: 'elk' 在 mermaid 12 运行时受支持但类型定义已移除，整体断言
  const config = {
    startOnLoad: false,
    theme: dark ? 'dark' : 'default',
    securityLevel: 'loose',
    // CJK 长标签适配：加大换行宽度与节点内边距，避免菱形/矩形文字溢出被裁；
    // fontFamily 与页面实际字体一致，否则 mermaid 的文本宽度测量会失准；
    // ELK 作为 flowchart 默认渲染器（需上方 registerLayoutLoaders 成功）
    flowchart: {
      useMaxWidth: true,
      htmlLabels: true,
      wrappingWidth: 280,
      padding: 14,
      defaultRenderer: 'elk',
    },
    mindmap: { useMaxWidth: true, padding: 12 },
    gantt: { useMaxWidth: true },
    themeVariables: {
      fontSize: '15px',
      fontFamily: '"PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif',
    },
  } as Parameters<typeof mermaid.initialize>[0]
  mermaid.initialize(config)
  const id = `mmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const { svg } = await mermaid.render(id, code.trim())
  return svg
}

/**
 * 字符串级 SVG 净化（Markdown 导出等非 DOM 场景）：移除脚本类向量。
 * 不能用 DOMPurify——会剥离 foreignObject 内的 HTML 文字（图表文字全丢）。
 */
export function sanitizeSvgString(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(
      /(href|xlink:href)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi,
      '$1="#"',
    )
}

/** sanitize 后可安全内联的 SVG（保留 foreignObject 与命名空间属性） */
function sanitizeSvg(svgText: string): string {
  return DOMPurify.sanitize(svgText, {
    ADD_TAGS: ['foreignObject'],
    ADD_ATTR: ['xmlns', 'xmlns:xlink', 'viewBox'],
  })
}

/**
 * mermaid 输出的针对性净化：移除脚本类向量（script/事件属性/javascript: 链接），
 * 但保留全部视觉结构。不能用 DOMPurify——它会剥离 foreignObject 内的 HTML 标签
 * （SVG/HTML 混合命名空间），导致图表文字全部丢失。
 */
function scrubDynamicSvg(holder: HTMLElement): void {
  holder.querySelectorAll('script, iframe, object, embed').forEach((s) => s.remove())
  holder.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (
        name.startsWith('on') ||
        ((name === 'href' || name === 'xlink:href') && /^\s*javascript:/i.test(attr.value))
      ) {
        el.removeAttribute(attr.name)
      }
    }
  })
}

export interface RichRenderOptions {
  /** 深色主题（mermaid 配色跟随）；导出场景传 false 固定浅色 */
  dark?: boolean
}

/**
 * markdown → 富 HTML：marked 解析 + DOMPurify 消毒 + svg/mermaid 代码块升级为图形。
 * 升级失败的 mermaid 保留源码并附错误提示条。
 */
export async function renderRichMarkdown(
  markdown: string,
  opts: RichRenderOptions = {},
): Promise<string> {
  const raw = marked.parse(markdown) as string
  const container = document.createElement('div')
  container.innerHTML = DOMPurify.sanitize(raw)

  const codeBlocks = Array.from(container.querySelectorAll('pre > code'))
  for (const code of codeBlocks) {
    const text = code.textContent ?? ''
    const lang = /language-([\w-]+)/.exec(code.className)?.[1] ?? ''
    const kind = detectFigure(lang, text)
    const pre = code.parentElement
    if (!kind || !pre) continue

    const holder = document.createElement('div')
    holder.className = 'md-figure'

    if (kind === 'svg') {
      const svg = sanitizeSvg(text.trim())
      if (!svg.includes('<svg')) continue
      holder.innerHTML = svg
      pre.replaceWith(holder)
      continue
    }

    try {
      const svg = await renderMermaidToSvg(text, opts.dark ?? false)
      holder.innerHTML = svg
      scrubDynamicSvg(holder)
      pre.replaceWith(holder)
    } catch (e) {
      const note = document.createElement('div')
      note.className = 'md-figure-error'
      note.textContent = `⚠️ 图表渲染失败（${(e as Error).message.slice(0, 80)}），已保留源码`
      pre.parentElement?.insertBefore(note, pre)
    }
  }

  // 时间轴表格升级：表头含时间列 + ≥2 条目 → 直观时间轴（timeline.md 规范样式）
  const tables = Array.from(container.querySelectorAll('table'))
  for (const tbl of tables) {
    const headerCells = tbl.querySelectorAll('thead th').length
      ? Array.from(tbl.querySelectorAll('thead th'))
      : tbl.querySelector('tr')
        ? Array.from(tbl.querySelector('tr')!.children)
        : []
    const header = headerCells.map((c) => c.textContent?.trim() ?? '')
    const bodyRows = tbl.querySelectorAll('tbody tr').length
      ? Array.from(tbl.querySelectorAll('tbody tr'))
      : Array.from(tbl.querySelectorAll('tr')).slice(header.length ? 1 : 0)
    const rows = bodyRows.map((tr) => Array.from(tr.children).map((td) => td.textContent?.trim() ?? ''))
    const data = detectTimeline(header, rows)
    if (!data) continue
    const holder = document.createElement('div')
    holder.className = 'md-figure'
    holder.innerHTML = renderTimelineHtml(data)
    tbl.replaceWith(holder)
  }
  return container.innerHTML
}
