// AI 总结结果导出：md / html / pdf / doc(word) / xlsx / pptx
// 重依赖全部动态 import，只在点击导出时加载对应 chunk
// html/pdf/doc 共用 richRender 富渲染管线（svg/mermaid 代码块 → 图形），与页面预览所见即所得
import { downloadText, timestampName } from '../utils'
import { markdownToWeChat } from './wechat'
import { renderRichMarkdown, renderMermaidToSvg } from './richRender'

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

const DOC_CSS = `
  body { font-family: "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif; color: #1f2937;
         line-height: 1.75; max-width: 760px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 1.7em; border-bottom: 3px solid #6366f1; padding-bottom: 10px; margin: 1.2em 0 0.8em; }
  h2 { font-size: 1.3em; border-left: 4px solid #6366f1; padding-left: 10px; margin: 1.4em 0 0.6em; }
  h3 { font-size: 1.1em; margin: 1.1em 0 0.5em; color: #4338ca; }
  table { border-collapse: collapse; width: 100%; margin: 0.8em 0; font-size: 0.92em; }
  th { background: #eef2ff; color: #3730a3; }
  th, td { border: 1px solid #d1d5db; padding: 6px 10px; text-align: left; }
  tr:nth-child(even) td { background: #f9fafb; }
  code { background: #f3f4f6; border-radius: 4px; padding: 1px 5px; font-size: 0.9em; }
  pre { background: #111827; color: #e5e7eb; border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
  pre code { background: none; color: inherit; }
  blockquote { border-left: 4px solid #a5b4fc; background: #f5f6ff; margin: 0.8em 0; padding: 8px 14px; color: #4b5563; }
  ul, ol { padding-left: 1.6em; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.4em 0; }
`

function wrapHtmlDocument(bodyHtml: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${DOC_CSS} @media print { body { padding: 0; } }</style>
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

async function exportMd(input: ExportInput): Promise<void> {
  downloadText(input.markdown, timestampName(input.title || 'AI总结', 'md'))
}

async function exportHtml(input: ExportInput): Promise<void> {
  const body = await renderHtmlBody(input.markdown)
  saveBlob(new Blob([wrapHtmlDocument(body, input.title)], { type: 'text/html;charset=utf-8' }), timestampName(input.title || 'AI总结', 'html'))
}

async function exportPdf(input: ExportInput): Promise<void> {
  const body = await renderHtmlBody(input.markdown)
  const html2pdf = (await import('html2pdf.js')).default
  const container = document.createElement('div')
  container.innerHTML = `<style>${DOC_CSS}</style>${body}`
  container.style.position = 'fixed'
  container.style.left = '-9999px'
  container.style.width = '720px'
  document.body.appendChild(container)
  try {
    await html2pdf()
      .set({
        margin: [10, 8, 10, 8],
        filename: timestampName(input.title || 'AI总结', 'pdf'),
        image: { type: 'jpeg', quality: 0.96 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      })
      .from(container)
      .save()
  } finally {
    container.remove()
  }
}

async function exportDoc(input: ExportInput): Promise<void> {
  const body = await renderHtmlBody(input.markdown)
  // Word 兼容 HTML（Word/WPS 均可直接打开编辑）
  const docHtml = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${input.title}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->
<style>${DOC_CSS}</style></head><body>${body}</body></html>`
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

/** SVG 文本 → PNG dataURL（mermaid 先经 richRender 渲染为 SVG），失败返回 null */
async function svgTextToPng(
  svgText: string,
): Promise<{ data: string; ratio: number } | null> {
  try {
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image()
      im.onload = () => res(im)
      im.onerror = () => rej(new Error('SVG 加载失败'))
      im.src = url
    })
    const ratio = img.width && img.height ? img.height / img.width : 0.42
    const width = 1400
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = Math.round(width * ratio)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#ffffff' // 深色主题下 canvas 默认透明，PPT 浅底需铺白
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    URL.revokeObjectURL(url)
    return { data: canvas.toDataURL('image/png'), ratio }
  } catch {
    return null
  }
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
    (b) => b.heading !== null || b.lines.some((l) => l.trim()),
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
        const svg =
          figCode.kind === 'svg' ? figCode.code : await renderMermaidToSvg(figCode.code, false)
        fig = await svgTextToPng(svg)
      } catch {
        fig = null
      }
    }
    // 块内内容 → 要点文本（跳过代码围栏与表格分隔行）
    const bullets: { text: string; options: { bullet?: boolean; fontSize: number } }[] = []
    let inFence = false
    for (const raw of b.lines) {
      const line = raw.trim()
      if (/^```/.test(line)) {
        inFence = !inFence
        continue
      }
      if (inFence || !line || /^\|?[\s:-]+\|/.test(line)) continue
      const text = line.replace(/^[-*+]\s+/, '').replace(/^#{3,6}\s+/, '▸ ')
      bullets.push({ text: text.slice(0, 120), options: { bullet: /^[-*+]\s+/.test(raw), fontSize: fig ? 11 : 14 } })
    }
    if (bullets.length) {
      slide.addText(
        bullets.map((b2) => ({ text: b2.text, options: b2.options })),
        {
          x: 0.6, y: fig ? 1.1 : 1.3,
          w: 8.8, h: fig ? 2.2 : 4.4,
          fontSize: fig ? 11 : 14, color: '374151', lineSpacingMultiple: 1.25, valign: 'top',
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
