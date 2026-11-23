// 富渲染：marked 解析 + 特殊代码块升级（G-SPEC 契约的可视化输出）
//  - ```mermaid（或无语言但以 mermaid 图类型开头）→ mermaid 渲染为 SVG 图表
//  - ```svg（或无语言但以 <svg 开头）→ 内联为真实 SVG 图形
// 预览（MarkdownView）与导出（exporters html/pdf/doc）共用本管线，保证所见即所得导出
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { detectTimeline, parseTimelineListItems, renderTimelineHtml } from './timeline'

marked.setOptions({ async: false, gfm: true, breaks: false })

/** 宽图阈值：固有宽度超过此值的图形标记为 .md-fig-wide（原尺寸横向滚动而非等比缩小） */
const WIDE_FIG_PX = 1100

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
    // 顶层 fontFamily 与 themeVariables 保持一致：文本测量与实际渲染用同一字体，
    // 否则测量偏窄 → 节点框比文字小 → foreignObject 内文字被裁（CJK 混排尤甚）
    fontFamily: '"PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif',
    // CJK 长标签适配：加大换行宽度与节点内边距，避免菱形/矩形文字溢出被裁；
    // ELK 作为 flowchart 默认渲染器（需上方 registerLayoutLoaders 成功）
    flowchart: {
      useMaxWidth: true,
      htmlLabels: true,
      wrappingWidth: 280,
      padding: 14,
      defaultRenderer: 'elk',
    },
    mindmap: { useMaxWidth: true, padding: 12 },
    // useWidth：把甘特图压缩到固定宽度（时间轴自动压缩），避免超宽图缩放后文字不可读
    gantt: { useMaxWidth: true, useWidth: 1100 },
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
      const fitted = fitSvgText(text.trim())
      if (!fitted.includes('<svg')) continue
      holder.innerHTML = fitted
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

  // 时间轴列表升级：模型按 G-SPEC 输出的「彩点 emoji + 日期」markdown 列表（非表格）
  // → 直观时间轴卡片（竖线连线 + 彩点 + 日期胶囊）
  const lists = Array.from(container.querySelectorAll('ul, ol')).filter(
    (l) => !l.closest('.md-figure'),
  )
  for (const list of lists) {
    const lis = Array.from(list.children).filter((c) => c.tagName === 'LI')
    if (lis.length < 2) continue
    const items = lis.map((li) => {
      const clone = li.cloneNode(true) as HTMLElement
      clone.querySelectorAll('ul, ol').forEach((n) => n.remove())
      return {
        text: (clone.textContent ?? '').trim(),
        strong: clone.querySelector('strong')?.textContent ?? undefined,
      }
    })
    const data = parseTimelineListItems(items)
    if (!data) continue
    const holder = document.createElement('div')
    holder.className = 'md-figure'
    holder.innerHTML = renderTimelineHtml(data)
    list.replaceWith(holder)
  }

  // 宽图标记：固有宽度超过阈值的图形不再等比缩放，改为原尺寸横向滚动
  // （超宽甘特图/横向流程图缩到容器宽后文字小到无法辨认，用户实测）；
  // 预览 .md-figure 自带 overflow-auto，打印/Word 由各自 CSS 兜底
  for (const el of Array.from(container.querySelectorAll('.md-figure svg'))) {
    const svg = el as SVGElement
    const vb = (svg.getAttribute('viewBox') ?? '')
      .split(/[\s,]+/)
      .map(Number)
    if (vb.length !== 4 || !(vb[2] > WIDE_FIG_PX)) continue
    svg.setAttribute('width', String(Math.round(vb[2])))
    svg.setAttribute('height', String(Math.round(vb[3])))
    svg.classList.add('md-fig-wide')
    svg.style.maxWidth = 'none'
  }
  return container.innerHTML
}

// ---------- 模型 SVG 文本溢出修复（fitSvgText） ----------
// 模型手写的 SVG 封面/示意图里，<text> 行宽经常超过所在框体/viewBox 右缘——
// 被裁掉（缩放、导出都救不回来，用户实测封面结论/参与人行被截断）。
// 修复策略（canvas 逐行测量文本宽度，坐标计入祖先 translate 变换）：
//   轻微超宽（≥0.75 倍）→ 缩字号；
//   内容较多（<0.75 倍）→ 按容器宽度自动换行成多行，框体不够高时增高 rect 并把
//   下方内容整体下移让位（保证框内文字全部可见，用户实测长结论被框体截断）；
//   带样式的 tspan 混排无法安全换行 → textLength 压缩兜底；
//   缺 viewBox 时由 width/height 属性补齐（否则容器缩放会变形）；
//   内容实际高度超出声明高度时用 getBBox 扩展，避免底部被裁。

/** 读取元素/祖先链上的 SVG 展示属性（font-size 等可继承，模型常写在 <g> 上） */
function svgInheritedAttr(el: Element, name: string): string | null {
  let cur: Element | null = el
  while (cur && cur.getAttribute) {
    const own = cur.getAttribute(name)
    if (own) return own
    const st = cur.getAttribute('style')
    if (st) {
      const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i').exec(st)
      if (m) return m[1].trim()
    }
    cur = cur.parentElement
  }
  return null
}

let fitCtx: CanvasRenderingContext2D | null = null

/** canvas 按元素继承的字体测量文本宽度（与浏览器实际渲染宽度基本一致） */
function measureSvgText(text: string, el: Element): number {
  if (!fitCtx) fitCtx = document.createElement('canvas').getContext('2d')
  if (!fitCtx) return text.length * 16
  const size = parseFloat(svgInheritedAttr(el, 'font-size') ?? '') || 16
  const weight = svgInheritedAttr(el, 'font-weight') ?? 'normal'
  const style = svgInheritedAttr(el, 'font-style') ?? 'normal'
  const family = svgInheritedAttr(el, 'font-family') ?? 'sans-serif'
  fitCtx.font = `${style} ${weight} ${size}px ${family}`.replace(/\s+/g, ' ').trim()
  return fitCtx.measureText(text).width
}

/** 矩形/路径框（含变换位移后的最终坐标），供「文本适配所在框」判定 */
interface SvgBox {
  x: number
  y: number
  w: number
  h: number
  el: Element
}

/** 解析元素自身 transform 的 translate 位移（rotate/scale 等视为坐标不可靠） */
function ownTranslate(el: Element): { dx: number; dy: number; ok: boolean } {
  const tr = el.getAttribute('transform') ?? ''
  if (/(rotate|scale|matrix|skew)/i.test(tr)) return { dx: 0, dy: 0, ok: false }
  const tm = /translate\(\s*(-?[\d.]+)[\s,]*(-?[\d.]*)\s*\)/i.exec(tr)
  return {
    dx: tm ? parseFloat(tm[1]) || 0 : 0,
    dy: tm ? parseFloat(tm[2] || '0') || 0 : 0,
    ok: true,
  }
}

/** 累计祖先链上的 translate 位移（模型常把内容包在 <g transform="translate"> 里，
 *  不计入会导致文字/框坐标全部错位、漏判溢出）；rotate/scale 视为坐标不可靠 */
function accumulateTranslate(el: Element, root: Element): { dx: number; dy: number; ok: boolean } {
  let dx = 0
  let dy = 0
  let cur: Element | null = el.parentElement
  while (cur && cur !== root) {
    const tr = cur.getAttribute?.('transform') ?? ''
    if (/(rotate|scale|matrix|skew)/i.test(tr)) return { dx: 0, dy: 0, ok: false }
    const tm = /translate\(\s*(-?[\d.]+)[\s,]*(-?[\d.]*)\s*\)/i.exec(tr)
    if (tm) {
      dx += parseFloat(tm[1]) || 0
      dy += parseFloat(tm[2] || '0') || 0
    }
    cur = cur.parentElement
  }
  return { dx, dy, ok: true }
}

/** 收集文本容器框：rect 直接用几何，path/polygon 画圆角框时用 getBBox 量出边界
 *  （需在 SVG 已挂载渲染树时调用）。带旋转/缩放的坐标不可靠，跳过。 */
function collectSvgBoxes(svg: Element): SvgBox[] {
  const boxes: SvgBox[] = []
  svg.querySelectorAll('rect, path, polygon').forEach((el) => {
    let bb: DOMRect
    try {
      bb = (el as SVGGraphicsElement).getBBox()
    } catch {
      return
    }
    if (!(bb.width > 0) || !(bb.height > 0)) return
    const own = ownTranslate(el)
    if (!own.ok) return
    const acc = accumulateTranslate(el, svg)
    if (!acc.ok) return
    boxes.push({ x: bb.x + own.dx + acc.dx, y: bb.y + own.dy + acc.dy, w: bb.width, h: bb.height, el })
  })
  return boxes
}

/** 按测量宽度贪心断行：优先在空白/CJK 字符后断，无断点的长串（URL/版本号）硬切 */
function breakText(text: string, measure: (s: string) => number, maxWidth: number): string[] {
  const isCjk = (ch: string) => /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef\u2014\u2026]/.test(ch)
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  const lines: string[] = []
  let cur = ''
  let lastBreak = -1 // cur 中允许断行的位置（空白/CJK 字符之后）
  for (const ch of chars) {
    if (cur && measure(cur + ch) > maxWidth) {
      if (lastBreak > 0) {
        lines.push(cur.slice(0, lastBreak).trimEnd())
        cur = cur.slice(lastBreak).replace(/^ /, '')
      } else {
        lines.push(cur)
        cur = ''
      }
      lastBreak = -1
      if (cur && measure(cur + ch) > maxWidth) {
        lines.push(cur)
        cur = ''
      }
    }
    cur += ch
    if (ch === ' ' || isCjk(ch)) lastBreak = cur.length
  }
  if (cur.trim()) lines.push(cur.trimEnd())
  return lines.filter((l) => l.length > 0)
}

/** 把最终位置在 thresholdY 之下的可定位元素整体下移 delta（模型封面是单列布局，
 *  换行增高后下方内容需同步让位，否则文字互相重叠） */
function shiftBelowSvg(svg: Element, thresholdY: number, delta: number, skip: Set<Element>): void {
  if (!(delta > 0)) return
  svg.querySelectorAll('rect, text, tspan, image, line, circle, ellipse').forEach((el) => {
    if (skip.has(el)) return
    const yOwn = parseFloat(el.getAttribute('y') ?? el.getAttribute('cy') ?? '')
    const y1 = parseFloat(el.getAttribute('y1') ?? '')
    const y2 = parseFloat(el.getAttribute('y2') ?? '')
    let accDy = 0
    let cur: Element | null = el.parentElement
    while (cur && cur !== svg) {
      const tm = /translate\(\s*(-?[\d.]+)[\s,]*(-?[\d.]*)\s*\)/i.exec(cur.getAttribute?.('transform') ?? '')
      if (tm) accDy += parseFloat(tm[2] || '0') || 0
      cur = cur.parentElement
    }
    let top: number
    if (Number.isFinite(yOwn)) top = yOwn + accDy
    else if (Number.isFinite(y1) && Number.isFinite(y2)) top = Math.min(y1, y2) + accDy
    else return // path 等无 y 信息的形状不参与平移
    if (top <= thresholdY) return
    const tr = el.getAttribute('transform')
    if (tr && /translate/i.test(tr)) {
      el.setAttribute(
        'transform',
        tr.replace(
          /translate\(\s*(-?[\d.]+)([\s,]+)(-?[\d.]+)\s*\)/i,
          (_m, tx, sep, ty) => `translate(${tx}${sep}${(parseFloat(ty) || 0) + delta})`,
        ),
      )
    } else {
      el.setAttribute('transform', `translate(0, ${delta})${tr ? ' ' + tr : ''}`)
    }
  })
}

/** 长文本换行到可用宽度：首行留在原元素，其余行克隆 <text> 依次下排；
 *  包含该行的矩形框高度不够时增高（仅 rect 可改），下方内容整体下移让位，
 *  保证「内容较多的文字在框内全部可见」而不是缩成一行或被截断 */
function wrapSvgLine(
  el: Element,
  avail: number,
  size: number,
  fy: number,
  startX: number,
  boxes: SvgBox[],
): void {
  const lines = breakText(el.textContent ?? '', (s) => measureSvgText(s, el), avail)
  if (lines.length <= 1) {
    el.setAttribute('textLength', String(Math.max(20, Math.round(avail))))
    el.setAttribute('lengthAdjust', 'spacingAndGlyphs')
    return
  }
  const lineH = Math.round(size * 1.5)
  const delta = (lines.length - 1) * lineH
  const y0 = parseFloat(el.getAttribute('y') ?? '0')
  const skip = new Set<Element>([el])
  // 克隆后续行
  let prev = el
  for (let i = 1; i < lines.length; i++) {
    const clone = el.cloneNode(false) as Element
    clone.setAttribute('y', String(y0 + i * lineH))
    clone.textContent = lines[i]
    prev.parentNode?.insertBefore(clone, prev.nextSibling)
    prev = clone
    skip.add(clone)
  }
  el.textContent = lines[0]
  // 增高所有纵向包含该行的矩形框（最内层框及外层容器），让框体容纳全部行
  const neededBottom = fy + delta + Math.max(6, size * 0.4)
  for (const b of boxes) {
    if (b.el.tagName !== 'rect') continue // path 框无法只改高度，保持不增高
    if (b.x - 2 <= startX && startX <= b.x + b.w && b.y <= fy && fy <= b.y + b.h) {
      if (neededBottom > b.y + b.h) {
        b.el.setAttribute('height', String(Math.round(b.h + (neededBottom - (b.y + b.h)))))
        b.h = neededBottom
        skip.add(b.el)
      }
    }
  }
  // 下方内容整体下移（同行元素 top ≈ fy 不受影响）
  shiftBelowSvg((el as SVGElement).ownerSVGElement ?? el, fy + lineH * 0.6, delta, skip)
}

/** 单行文本溢出修复。可用宽度取「所在最小容器框」与 viewBox 右缘的较小者；
 *  轻微超宽（≥0.75 倍）缩字号；内容较多时换行成多行（框体增高+下方让位）；
 *  带样式的 tspan 混排无法安全换行，退回 textLength 压缩 */
function fitSvgLine(el: Element, W: number, boxes: SvgBox[]): void {
  if (el.closest('foreignObject')) return
  const content = (el.textContent ?? '').trim()
  if (!content) return
  const xAttr = (el.getAttribute('x') ?? '').trim()
  if (!xAttr || /\s/.test(xAttr)) return
  const x = parseFloat(xAttr)
  if (!Number.isFinite(x) || x < 0) return
  const y = parseFloat(el.getAttribute('y') ?? '')
  const hasY = Number.isFinite(y)
  const own = ownTranslate(el)
  if (!own.ok) return // 自身带旋转/缩放，坐标不可靠
  const svg = (el as SVGElement).ownerSVGElement
  const acc = svg ? accumulateTranslate(el, svg) : { dx: 0, dy: 0, ok: false }
  if (!acc.ok) return
  const fx = x + own.dx + acc.dx
  const fy = hasY ? y + own.dy + acc.dy : NaN
  const anchor = (svgInheritedAttr(el, 'text-anchor') ?? 'start').trim()
  const m = measureSvgText(el.textContent ?? '', el)
  if (m <= 0) return
  const startX = fx + (anchor === 'middle' ? -m / 2 : anchor === 'end' ? -m : 0)
  const size = parseFloat(svgInheritedAttr(el, 'font-size') ?? '') || 16
  // 所在最小容器框：横向包含文字起点、纵向覆盖基线；过滤下划线/分隔线等非容器形状
  let box: SvgBox | null = null
  if (Number.isFinite(fy)) {
    for (const b of boxes) {
      if (b.w < size || b.h < size * 0.8) continue
      if (b.x - 2 <= startX && startX <= b.x + b.w && b.y <= fy && fy <= b.y + b.h) {
        if (!box || b.w < box.w) box = b
      }
    }
  }
  const boxAvail = box ? box.x + box.w - 10 - startX : Infinity
  const avail = Math.min(boxAvail, W - 10 - startX)
  if (avail <= 0 || m <= avail) return
  const scale = avail / m
  if (el.children.length === 0 && scale >= 0.75) {
    el.setAttribute('font-size', String(Math.round(size * scale * 10) / 10))
    return
  }
  if (el.children.length === 0 && el.tagName === 'text' && hasY) {
    wrapSvgLine(el, avail, size, fy, startX, boxes)
    return
  }
  el.setAttribute('textLength', String(Math.max(20, Math.round(avail))))
  el.setAttribute('lengthAdjust', 'spacingAndGlyphs')
}

/**
 * 模型 SVG 的文本溢出修复 + viewBox/高度兜底，返回修复后的 SVG 字符串
 * （XMLSerializer 序列化，可直接用于 DOM 内联或 data:URL 光栅化）。
 * 非 SVG 输入原样返回。
 */
export function fitSvgText(svgText: string): string {
  const trimmed = svgText.trim()
  if (!/^<svg[\s>]/i.test(trimmed)) return svgText
  const holder = document.createElement('div')
  holder.innerHTML = sanitizeSvg(trimmed)
  const svg = holder.querySelector('svg')
  if (!svg) return svgText

  const wAttr = parseFloat(svg.getAttribute('width') ?? '')
  const hAttr = parseFloat(svg.getAttribute('height') ?? '')
  let vb = (svg.getAttribute('viewBox') ?? '')
    .split(/[\s,]+/)
    .map(Number)
  if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n))) vb = []
  if (!vb.length && wAttr > 0 && hAttr > 0) {
    svg.setAttribute('viewBox', `0 0 ${wAttr} ${hAttr}`)
    vb = [0, 0, wAttr, hAttr]
  }
  const W = vb.length === 4 && vb[2] > 0 ? vb[2] : wAttr > 0 ? wAttr : 0

  // 挂载到渲染树（隐藏）：path 框采集与内容高度测量都依赖 getBBox
  const needLayout = W > 0 || (vb.length === 4 && vb[3] > 0)
  if (needLayout) {
    holder.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden'
    document.body.appendChild(holder)
  }
  try {
    if (W > 0) {
      const boxes = collectSvgBoxes(svg)
      for (const t of Array.from(svg.querySelectorAll('text'))) {
        // 多行文本（tspan 分行）无法按整行测量，跳过
        if (Array.from(t.children).some((c) => c.tagName === 'tspan' && (c.hasAttribute('dy') || c.hasAttribute('y')))) continue
        const xTs = Array.from(t.querySelectorAll('tspan')).filter((s) => {
          const xa = (s.getAttribute('x') ?? '').trim()
          return xa && !/\s/.test(xa)
        })
        if (xTs.length) xTs.forEach((s) => fitSvgLine(s, W, boxes))
        else fitSvgLine(t, W, boxes)
      }
    }

    // 高度兜底：量实际内容高度，超出声明高度则扩展 viewBox（底部被裁的场景）
    if (vb.length === 4 && vb[3] > 0) {
      const box = svg.getBBox()
      const contentH = box.y + box.height
      if (contentH > vb[3] + 8) {
        const newH = Math.ceil(contentH + 8)
        svg.setAttribute('viewBox', `${vb[0]} ${vb[1]} ${vb[2] || W} ${newH}`)
        if (svg.hasAttribute('height')) svg.setAttribute('height', String(newH))
      }
    }
  } catch {
    // 个别内容无法测量，忽略
  } finally {
    if (needLayout) holder.remove()
  }
  return new XMLSerializer().serializeToString(svg)
}
