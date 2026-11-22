// 富渲染：marked 解析 + 特殊代码块升级（G-SPEC 契约的可视化输出）
//  - ```mermaid（或无语言但以 mermaid 图类型开头）→ mermaid 渲染为 SVG 图表
//  - ```svg（或无语言但以 <svg 开头）→ 内联为真实 SVG 图形
// 预览（MarkdownView）与导出（exporters html/pdf/doc）共用本管线，保证所见即所得导出
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ async: false, gfm: true, breaks: false })

/** mermaid 图类型的起始关键字（无语言标注时的兜底识别） */
const MERMAID_START =
  /^(flowchart|graph|mindmap|gantt|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|journey|pie|gitGraph|quadDiagram|requirementDiagram|sankey-beta|xychart-beta|timeline|block-beta)\b/

/** 判断代码块是否为可渲染图形（svg / mermaid），返回类型 */
export function detectFigure(lang: string, code: string): 'svg' | 'mermaid' | null {
  const l = lang.toLowerCase()
  if (l === 'svg') return 'svg'
  if (l === 'mermaid') return 'mermaid'
  if (!l) {
    if (/^\s*<svg[\s>]/i.test(code)) return 'svg'
    if (MERMAID_START.test(code.trim())) return 'mermaid'
  }
  return null
}

let mermaidMod: typeof import('mermaid') | null = null

/** mermaid 渲染为 SVG 字符串（失败抛错，由调用方降级保留源码） */
export async function renderMermaidToSvg(code: string, dark = false): Promise<string> {
  if (!mermaidMod) mermaidMod = await import('mermaid')
  const mermaid = mermaidMod.default
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? 'dark' : 'default',
    securityLevel: 'loose',
  })
  const id = `mmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const { svg } = await mermaid.render(id, code.trim())
  return svg
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
  return container.innerHTML
}
