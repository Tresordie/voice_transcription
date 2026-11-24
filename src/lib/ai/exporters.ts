// AI 总结结果导出：md / html / pdf / doc(word) / xlsx / pptx
// 重依赖全部动态 import，只在点击导出时加载对应 chunk
// html/pdf/doc 共用 richRender 富渲染管线（svg/mermaid 代码块 → 图形），与页面预览所见即所得
import { downloadText, timestampName } from '../utils'
import { markdownToWeChat } from './wechat'
import { renderRichMarkdown, renderMermaidToSvg, sanitizeSvgString, detectFigure, fitSvgText } from './richRender'
import { detectTimeline, timelineEntriesToSvg, parseTimelineListItems, renderTimelineHtml } from './timeline'

export type ExportFormat = 'md' | 'html' | 'pdf' | 'doc' | 'xlsx' | 'pptx'

export interface ExportInput {
  /** 文件名前缀（如「会议纪要」） */
  title: string
  /** 完整 markdown 内容 */
  markdown: string
}

// ---------- markdown → HTML（导出 html/pdf/doc 共用的排版模板） ----------

async function renderHtmlBody(markdown: string): Promise<string> {
  return renderRichMarkdown(markdown, { dark: false })
}

const DOC_CSS_RULES = `
  #ai-export-root img { max-width: 100%; }
  #ai-export-root .md-figure { margin: 1.2em 0; overflow-x: auto; }
  #ai-export-root .md-figure svg { max-width: 100%; height: auto; }
  #ai-export-root .md-figure svg.md-fig-wide { width: auto; max-width: none; }
  #ai-export-root h1 { font-size: 1.7em; border-bottom: 3px solid #6366f1; padding-bottom: 10px; margin: 1.2em 0 0.8em; }
  #ai-export-root h2 { font-size: 1.3em; border-left: 4px solid #6366f1; padding-left: 10px; margin: 1.4em 0 0.6em; }
  #ai-export-root h3 { font-size: 1.1em; margin: 1.1em 0 0.5em; color: #4338ca; }
  #ai-export-root table { border-collapse: collapse; width: 100%; margin: 0.8em 0; font-size: 0.92em; }
  #ai-export-root th { background: #eef2ff; color: #3730a3; }
  #ai-export-root th, #ai-export-root td { border: 1px solid #d1d5db; padding: 6px 10px; text-align: left; }
  #ai-export-root tr:nth-child(even) td { background: #f9fafb; }
  #ai-export-root code { background: #f3f4f6; border-radius: 4px; padding: 1px 5px; font-size: 0.9em; }
  #ai-export-root pre { background: #111827; color: #e5e7eb; border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
  #ai-export-root pre code { background: none; color: inherit; }
  #ai-export-root blockquote { border-left: 4px solid #a5b4fc; background: #f5f6ff; margin: 0.8em 0; padding: 8px 14px; color: #4b5563; }
  #ai-export-root ul, #ai-export-root ol { padding-left: 1.6em; }
  #ai-export-root hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.4em 0; }
`
// 导出 html/doc 用（独立文档，body 级样式）；pdf 用根作用域版本避免泄漏到应用页面
// 屏显宽度与应用主容器同步（App.tsx max-w-7xl = 1280px）；打印宽度由 PRINT_CSS 收回纸张宽度
const DOC_CSS = `
  body { font-family: "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif; color: #1f2937;
         line-height: 1.75; max-width: 1280px; margin: 0 auto; padding: 32px 24px; }
  ${DOC_CSS_RULES.replaceAll('#ai-export-root', 'body')}
`
// PDF 打印兜底：纸张无法滚动，宽图退回等比缩放（完整优先于清晰）；
// 正文宽度收回 A4 可打印宽度（约 760px @96dpi），否则 1280px 会被打印缩放导致文字变小
const PRINT_CSS = `
  @media print {
    body { padding: 0; max-width: 760px; }
    body .md-figure svg.md-fig-wide { width: auto !important; max-width: 100% !important; }
  }
`

/** Word 可打印区域宽度（A4 - 默认页边距，96dpi 像素） */
const WORD_IMG_WIDTH = 600

/**
 * 把富渲染产物中的 .md-figure SVG 替换为 PNG <img>：
 * html2canvas 不渲染 foreignObject（mermaid 文字会丢）、对内联 SVG 支持不稳；
 * Word 兼容 HTML 对内联 SVG 同样不可靠。PNG 走 canvas 白底铺底，两处都完美显示。
 * img 显式设置 width/height 属性——Word/WPS 不理会 max-width 样式，
 * 1400px 原图会超出页面被裁（用户实测）。
 */
async function replaceFiguresWithPng(root: ParentNode): Promise<void> {
  const figures = Array.from(root.querySelectorAll('.md-figure'))
  for (const fig of figures) {
    const svg = fig.querySelector('svg')
    if (!svg) continue
    const svgText = new XMLSerializer().serializeToString(svg)
    const png = await svgTextToPng(svgText)
    if (!png) continue
    const img = document.createElement('img')
    img.src = png.data
    img.width = WORD_IMG_WIDTH
    img.height = Math.round(WORD_IMG_WIDTH * png.ratio)
    fig.replaceChildren(img)
  }
}

function wrapHtmlDocument(bodyHtml: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${DOC_CSS} ${PRINT_CSS}</style>
</head>
<body>${bodyHtml}</body>
</html>`
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

// ---------- 各格式导出 ----------

/**
 * markdown 中的 svg/mermaid 代码块与裸 <svg> HTML 块 → PNG data URI 内嵌图；
 * 时间轴列表（彩点 emoji + 日期开头）→ 时间轴卡片 HTML。
 *
 * 图形不保留内联 SVG 的原因（用户实测）：Typora 等查看器会剥离 SVG 内嵌 <style>
 * （rect 默认 fill=黑 → 全部黑块），foreignObject 里的文字也不渲染；PNG data URI
 * 在 Typora / VS Code / Obsidian / GitHub 等所有主流查看器中显示一致。
 * 转换失败时回落内联 SVG / 保留源码。其余 markdown 原样保留。
 */
export async function upgradeMarkdownFigures(markdown: string): Promise<string> {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inFence = false
  let lang = ''
  let buf: string[] = []
  // 裸 <svg> HTML 块收集（模型常把封面/示意图直接写成 HTML 块而非围栏）
  let inSvg = false
  let svgLines: string[] = []
  // 时间轴列表行收集（连续的 -/*/# 列表行）
  let listLines: string[] | null = null

  /** SVG 代码 → PNG data URI（先做文本溢出修复再光栅化），失败返回 null */
  const svgToPng = async (code: string): Promise<string | null> => {
    try {
      const fitted = fitSvgText(code.trim())
      if (!fitted.includes('<svg')) return null
      return (await svgTextToPng(fitted))?.data ?? null
    } catch {
      return null
    }
  }

  /** 时间轴列表行 flush：命中则输出时间轴卡片 HTML，否则原样回放 */
  const flushList = (): void => {
    if (!listLines) return
    const src = listLines
    listLines = null
    if (src.length >= 2) {
      const items = src.map((l) => {
        const raw = l.replace(/^\s*(?:[-*+•▸►]|\d+[.)])\s+/, '')
        const strong = /\*\*([^*]+)\*\*/.exec(raw)?.[1]
        const text = raw
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/`([^`]+)`/g, '$1')
          .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
          .trim()
        return { text, strong }
      })
      const data = parseTimelineListItems(items)
      if (data) {
        out.push('', renderTimelineHtml(data), '')
        return
      }
    }
    out.push(...src)
  }

  const flush = async (): Promise<void> => {
    const code = buf.join('\n')
    const kind = detectFigure(lang, code)
    if (kind === 'svg') {
      const png = await svgToPng(code)
      out.push(png ? `![图形](${png})` : sanitizeSvgString(code.trim()), '')
    } else if (kind === 'mermaid') {
      try {
        const svg = await renderMermaidToSvg(code, false)
        const png = await svgTextToPng(svg)
        out.push(png ? `![图形](${png.data})` : sanitizeSvgString(svg), '')
      } catch {
        out.push('```mermaid', code, '```', '')
      }
    } else {
      out.push('```' + lang, ...buf, '```', '')
    }
    inFence = false
    lang = ''
    buf = []
  }
  for (const line of lines) {
    const t = line.trim()
    if (!inFence && !inSvg && t.startsWith('```')) {
      flushList()
      lang = t.slice(3).trim().toLowerCase()
      inFence = true
      buf = []
      continue
    }
    if (inFence) {
      if (t.startsWith('```') && t.length <= 3 + lang.length) {
        await flush()
        continue
      }
      buf.push(line)
      continue
    }
    if (!inSvg && /^\s*<svg[\s>]/i.test(line)) {
      flushList()
      if (/<\/svg\s*>/i.test(line)) {
        // 单行 svg
        const png = await svgToPng(line)
        out.push(png ? `![图形](${png})` : line, '')
        continue
      }
      inSvg = true
      svgLines = [line]
      continue
    }
    if (inSvg) {
      svgLines.push(line)
      if (/<\/svg\s*>/i.test(line)) {
        const code = svgLines.join('\n')
        const src = svgLines
        svgLines = []
        inSvg = false
        const png = await svgToPng(code)
        if (png) out.push(`![图形](${png})`, '')
        else out.push('', ...src, '')
      }
      continue
    }
    // 时间轴列表行收集：列表标记行入队，缩进续行并入上一条，其余行先 flush 列表
    if (/^\s*(?:[-*+•▸►]|\d+[.)])\s+\S/.test(line)) {
      if (!listLines) listLines = []
      listLines.push(line)
      continue
    }
    if (listLines) {
      if (line.trim() && /^\s+\S/.test(line)) {
        listLines[listLines.length - 1] += ' ' + line.trim()
        continue
      }
      flushList()
    }
    out.push(line)
  }
  if (inFence) await flush() // 未闭合围栏兜底
  if (inSvg) out.push('', ...svgLines, '') // 未闭合 svg 兜底：原样回放
  flushList()
  return out.join('\n')
}

async function exportMd(input: ExportInput): Promise<void> {
  const md = await upgradeMarkdownFigures(input.markdown)
  downloadText(md, timestampName(input.title || 'AI总结', 'md'))
}

async function exportHtml(input: ExportInput): Promise<void> {
  const body = await renderHtmlBody(input.markdown)
  saveBlob(new Blob([wrapHtmlDocument(body, input.title)], { type: 'text/html;charset=utf-8' }), timestampName(input.title || 'AI总结', 'html'))
}

async function exportPdf(input: ExportInput): Promise<void> {
  const body = await renderHtmlBody(input.markdown)
  const html = wrapHtmlDocument(body, input.title)
  // PDF 走浏览器打印引擎（打印对话框内选「另存为 PDF」）：
  // html2canvas/html-to-image 两条 canvas 光栅化路线在本应用均不可靠——
  // ① html2canvas 解析 Tailwind v4 的 oklch 颜色抛错（克隆文档无法隔离干净）
  // ② 两条路线都不渲染 foreignObject（mermaid 文字丢失）③ 离屏定位/负 z-index 产出空白画布
  // 打印引擎原生渲染，图形/表格/中文字体全部保真。
  const w = window.open('', '_blank', 'width=880,height=960')
  if (!w) throw new Error('浏览器拦截了导出窗口，请允许本站弹窗后重试')
  w.document.open()
  w.document.write(html)
  w.document.close()
  const print = () => {
    try {
      w.focus()
      w.print()
    } catch {
      // 用户关闭窗口等场景忽略
    }
  }
  // 等待内嵌 PNG 图片与字体就绪后再唤起打印
  if (w.document.fonts?.ready) {
    void w.document.fonts.ready.then(() => setTimeout(print, 300))
  } else {
    setTimeout(print, 500)
  }
}

async function exportDoc(input: ExportInput): Promise<void> {
  const body = await renderHtmlBody(input.markdown)
  // Word 兼容 HTML（Word/WPS 均可直接打开编辑）；内联 SVG 转 PNG（Word 对 SVG 支持不可靠）
  const parsed = new DOMParser().parseFromString(
    `<html><head></head><body>${body}</body></html>`,
    'text/html',
  )
  await replaceFiguresWithPng(parsed.body)
  // PNG 转换失败的兜底：内联 SVG 显式缩放到可打印宽度（Word 不理会 max-width 样式）
  parsed.body.querySelectorAll('.md-figure svg').forEach((svg) => {
    svg.classList.remove('md-fig-wide')
    const vb = (svg.getAttribute('viewBox') ?? '')
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => !Number.isNaN(n))
    if (vb.length === 4 && vb[2] > 0) {
      svg.setAttribute('width', String(WORD_IMG_WIDTH))
      svg.setAttribute('height', String(Math.round((WORD_IMG_WIDTH * vb[3]) / vb[2])))
    } else {
      svg.setAttribute('width', String(WORD_IMG_WIDTH))
      svg.setAttribute('height', String(Math.round(WORD_IMG_WIDTH * 0.4)))
    }
    svg.removeAttribute('style')
  })
  const docHtml = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${input.title}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->
<style>${DOC_CSS}</style></head><body>${parsed.body.innerHTML}</body></html>`
  saveBlob(new Blob(['\ufeff', docHtml], { type: 'application/msword;charset=utf-8' }), timestampName(input.title || 'AI总结', 'doc'))
}

// ---------- markdown 结构解析（xlsx / pptx 共用） ----------

interface MdBlock {
  /** 标题（h1/h2），无标题的块为 null */
  heading: string | null
  level: number
  /** 该块内的行（不含标题行） */
  lines: string[]
}

/** 按 h1/h2 把 markdown 切成块；h3+ 保留在块内 */
function splitMarkdownBlocks(markdown: string): MdBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let cur: MdBlock = { heading: null, level: 0, lines: [] }
  for (const line of lines) {
    const m = line.match(/^(#{1,2})\s+(.*)$/)
    if (m) {
      if (cur.heading !== null || cur.lines.some((l) => l.trim())) blocks.push(cur)
      cur = { heading: m[2].trim(), level: m[1].length, lines: [] }
    } else {
      cur.lines.push(line)
    }
  }
  if (cur.heading !== null || cur.lines.some((l) => l.trim())) blocks.push(cur)
  return blocks
}

/** 提取块内的 markdown 表格行（已去分隔行），无则 null */
function extractTable(lines: string[]): { header: string[]; rows: string[][] } | null {
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].includes('|') && /^\s*\|?[\s:-]+\|/.test(lines[i + 1] ?? '')) {
      const parse = (l: string) =>
        l
          .split('|')
          .map((c) => c.trim())
          .filter((c, idx, arr) => !(idx === 0 && !c) && !(idx === arr.length - 1 && !c))
      const header = parse(lines[i])
      const rows: string[][] = []
      for (let j = i + 2; j < lines.length && lines[j].includes('|'); j++) {
        if (/^\s*\|?[\s:-]+\|/.test(lines[j])) continue
        rows.push(parse(lines[j]))
      }
      return { header, rows }
    }
  }
  return null
}

async function exportXlsx(input: ExportInput): Promise<void> {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()
  const blocks = splitMarkdownBlocks(input.markdown)

  // 概要工作表：标题 + 各块的纯文本要点
  const summary: (string | number)[][] = [[input.title]]
  for (const b of blocks) {
    if (b.heading) summary.push([b.heading])
    for (const l of b.lines) {
      const t = l.trim()
      if (t && !t.includes('|') && !/^```/.test(t)) summary.push([t])
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), '概要')

  // 每个含表格的块一个工作表
  let sheetIdx = 1
  for (const b of blocks) {
    const table = extractTable(b.lines)
    if (!table) continue
    const aoa = [table.header, ...table.rows]
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    XLSX.utils.book_append_sheet(wb, ws, (b.heading ?? `表格${sheetIdx}`).slice(0, 31))
    sheetIdx++
  }

  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  saveBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), timestampName(input.title || 'AI总结', 'xlsx'))
}

/** 提取块内第一个图形代码块（```mermaid / ```svg），供 PPT 转图 */
function firstFigureCode(lines: string[]): { kind: 'svg' | 'mermaid'; code: string } | null {
  let inFence = false
  let lang = ''
  let buf: string[] = []
  for (const l of lines) {
    const t = l.trim()
    if (!inFence && t.startsWith('```')) {
      const declared = t.slice(3).trim().toLowerCase()
      if (declared === 'mermaid' || declared === 'svg') lang = declared
      else lang = 'skip' // 非目标围栏，跳过其内容
      inFence = true
      buf = []
      continue
    }
    if (inFence) {
      if (t === '```') {
        if (lang === 'mermaid' || lang === 'svg') return { kind: lang, code: buf.join('\n') }
        inFence = false
        lang = ''
        buf = []
        continue
      }
      buf.push(l)
    }
  }
  return null
}

/** SVG 尺寸归一：mermaid 输出 width="100%"（img 加载无绝对尺寸，naturalWidth 不可靠），
 *  依 viewBox 换算为像素宽高，光栅化分辨率才与文字实际大小一致 */
function normalizeSvgSize(svgText: string): string {
  const holder = document.createElement('div')
  holder.innerHTML = svgText
  const svg = holder.querySelector('svg')
  if (!svg) return svgText
  const wRaw = svg.getAttribute('width') ?? ''
  const vb = (svg.getAttribute('viewBox') ?? '')
    .split(/[\s,]+/)
    .map(Number)
  if ((!wRaw || wRaw.includes('%')) && vb.length === 4 && vb.every((n) => Number.isFinite(n))) {
    svg.setAttribute('width', String(vb[2]))
    svg.setAttribute('height', String(vb[3]))
    svg.style.maxWidth = 'none'
    return new XMLSerializer().serializeToString(svg)
  }
  return svgText
}

/** SVG 文本 → PNG dataURL（mermaid 先经 richRender 渲染为 SVG），失败返回 null。
 *  必须用 data: URL 加载——blob: URL 加载 SVG 会污染 canvas，toDataURL 直接抛错 */
async function svgTextToPng(
  svgText: string,
): Promise<{ data: string; ratio: number } | null> {
  try {
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(normalizeSvgSize(svgText))
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image()
      im.onload = () => res(im)
      im.onerror = () => rej(new Error('SVG 加载失败'))
      im.src = url
    })
    const ratio = img.width && img.height ? img.height / img.width : 0.42
    // 分辨率跟随图形固有尺寸（上限 3200）：超宽甘特/流程图按原尺寸光栅化，
    // 固定 1400 会把宽图文字等比缩小到不可辨认
    const width = Math.min(3200, Math.max(1400, Math.round(img.width) || 1400))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = Math.round(width * ratio)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#ffffff' // 深色主题下 canvas 默认透明，PPT 浅底需铺白
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return { data: canvas.toDataURL('image/png'), ratio }
  } catch {
    return null
  }
}

/** 行内 markdown 清理（PPT/表格单元格用）：去掉 **加粗**、`代码`、链接等标记 */
function inlineClean(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .trim()
}

async function exportPptx(input: ExportInput): Promise<void> {
  const PptxGenJS = (await import('pptxgenjs')).default
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'

  // 封面
  const cover = pptx.addSlide()
  cover.background = { color: '1e1b4b' }
  cover.addText(input.title || 'AI 总结', { x: 0.6, y: 2.2, w: 8.8, fontSize: 34, bold: true, color: 'ffffff' })
  cover.addText(new Date().toLocaleDateString('zh-CN'), { x: 0.6, y: 3.4, w: 8.8, fontSize: 14, color: 'c7d2fe' })

  const blocks = splitMarkdownBlocks(input.markdown).filter(
    // 只有标题、没有内容行的块（如全文大标题）不生成幻灯片——封面已含标题
    (b) => b.lines.some((l) => l.trim()),
  )
  for (const b of blocks) {
    const slide = pptx.addSlide()
    slide.addText(b.heading ?? input.title, {
      x: 0.6, y: 0.4, w: 8.8, fontSize: 24, bold: true, color: '312e81',
    })
    // 块内图形（svg/mermaid）→ PNG 插图
    let fig: { data: string; ratio: number } | null = null
    const figCode = firstFigureCode(b.lines)
    if (figCode) {
      try {
        // 模型手写 SVG 先做文本溢出修复（超宽行缩字号/textLength 压缩）
        const svg =
          figCode.kind === 'svg' ? fitSvgText(figCode.code) : await renderMermaidToSvg(figCode.code, false)
        fig = await svgTextToPng(svg)
      } catch {
        fig = null
      }
    }

    // 内容解析：第一个 markdown 表格 → PPT 原生表格；其余行 → 要点（breakLine 逐行换行）
    const table = extractTable(b.lines)
    // 时间轴表格 → 直观时间轴 SVG 图（替代原生表格）
    const timelineData = table ? detectTimeline(table.header, table.rows) : null
    if (timelineData) {
      try {
        const svg = timelineEntriesToSvg(timelineData)
        const png = await svgTextToPng(svg)
        if (png) {
          const w = Math.min(8.4, 4.9 / png.ratio)
          const h = w * png.ratio
          slide.addImage({ data: png.data, x: (10 - w) / 2, y: 0.9 + (5.1 - h) / 2, w, h })
          continue
        }
      } catch {
        // 转换失败回落原生表格
      }
    }
    const bullets: { text: string; options: Record<string, unknown> }[] = []
    let inFence = false
    for (const raw of b.lines) {
      const line = raw.trim()
      if (/^```/.test(line)) {
        inFence = !inFence
        continue
      }
      if (inFence || !line) continue
      // 表格行交给 addTable（内容行与分隔行都跳过）
      if (line.startsWith('|')) continue
      // 分割线跳过
      if (/^(-{3,}|={3,}|\*{3,})$/.test(line)) continue
      const heading = line.match(/^(#{3,6})\s+(.*)$/)
      const text = inlineClean(heading ? `▸ ${heading[2]}` : line.replace(/^[-*+]\s+/, ''))
      if (text) {
        bullets.push({
          text: text.slice(0, 160),
          options: {
            bullet: /^[-*+]\s+/.test(raw) && !heading,
            breakLine: true, // 关键：不设则所有段落在同一行内流动
            fontSize: fig ? 10 : 13,
          },
        })
      }
    }

    // 布局（防重叠的确定性分支）：
    //   图+表格：表格在上（≤8 行），图形在下，要点省略
    //   图+无表格：要点压上半，图形占下半
    //   无图+表格：表格在上，要点在下
    //   都没有：要点占满
    const hasTable = table && table.rows.length > 0
    const maxTableRows = fig ? 8 : 14
    const tableRowCount = hasTable ? Math.min(table!.rows.length, maxTableRows) + 1 : 0
    const tableH = hasTable ? Math.min(3.6, tableRowCount * 0.32 + 0.15) : 0

    if (hasTable) {
      const header = table!.header.map((h) => ({
        text: inlineClean(h).slice(0, 40),
        options: { bold: true, color: '3730a3', fill: { color: 'eef2ff' } },
      }))
      const rows = [
        header,
        ...table!.rows.slice(0, maxTableRows).map((r) =>
          r.map((c) => ({ text: inlineClean(c).slice(0, 80) })),
        ),
      ]
      const yTop = fig ? 1.05 : 1.25
      slide.addTable(rows, {
        x: 0.6, y: yTop, w: 8.8,
        fontSize: 11, border: { pt: 1, color: 'd1d5db' },
        margin: 0.06, valign: 'middle', autoPage: false,
      })
      if (table!.rows.length > maxTableRows) {
        slide.addText(`（表格共 ${table!.rows.length} 行，此处仅显示前 ${maxTableRows} 行，完整内容见 Word / HTML 导出）`, {
          x: 0.6, y: yTop + tableH + 0.05, w: 8.8, fontSize: 9, italic: true, color: '9ca3af',
        })
      }
    }

    const showBullets =
      bullets.length > 0 && !(fig && hasTable) && !(hasTable && 1.25 + tableH > 4.6)
    if (showBullets) {
      const yTop = fig ? 1.05 : hasTable ? 1.25 + tableH + 0.1 : 1.3
      const hAvail = fig ? (hasTable ? 1.9 : 2.2) : hasTable ? 5.55 - yTop : 4.4
      slide.addText(
        bullets.map((b2) => ({ text: b2.text, options: b2.options })),
        {
          x: 0.6, y: yTop,
          w: 8.8, h: Math.max(1.2, hAvail),
          fontSize: fig ? 10 : 13, color: '374151', lineSpacingMultiple: 1.2,
          valign: 'top', fit: 'shrink', // 超出时自动缩字号防溢出
        },
      )
    }
    if (fig) {
      let w = Math.min(9, 2.05 / fig.ratio)
      const h = w * fig.ratio
      slide.addImage({ data: fig.data, x: (10 - w) / 2, y: 3.4 + (2.1 - h) / 2, w, h })
    }
  }
  await pptx.writeFile({ fileName: timestampName(input.title || 'AI总结', 'pptx') })
}

// ---------- 入口 ----------

export async function exportSummary(fmt: ExportFormat, input: ExportInput): Promise<void> {
  switch (fmt) {
    case 'md':
      return exportMd(input)
    case 'html':
      return exportHtml(input)
    case 'pdf':
      return exportPdf(input)
    case 'doc':
      return exportDoc(input)
    case 'xlsx':
      return exportXlsx(input)
    case 'pptx':
      return exportPptx(input)
  }
}

// 复用微信格式转换（页面快捷复制按钮用）
export { markdownToWeChat }
