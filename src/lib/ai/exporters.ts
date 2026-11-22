// AI 总结结果导出：md / html / pdf / doc(word) / xlsx / pptx
// 重依赖全部动态 import，只在点击导出时加载对应 chunk
import { downloadText, timestampName } from '../utils'
import { markdownToWeChat } from './wechat'

export type ExportFormat = 'md' | 'html' | 'pdf' | 'doc' | 'xlsx' | 'pptx'

export interface ExportInput {
  /** 文件名前缀（如「会议纪要」） */
  title: string
  /** 完整 markdown 内容 */
  markdown: string
}

// ---------- markdown → HTML（导出 html/pdf/doc 共用的排版模板） ----------

async function renderHtmlBody(markdown: string): Promise<string> {
  const { marked } = await import('marked')
  const DOMPurify = (await import('dompurify')).default
  const html = marked.parse(markdown, { async: false }) as string
  return DOMPurify.sanitize(html)
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
    // 块内内容 → 要点文本（去掉表格分隔行与代码围栏）
    const bullets: { text: string; options: { bullet?: boolean; fontSize: number } }[] = []
    for (const raw of b.lines) {
      const line = raw.trim()
      if (!line || /^```/.test(line) || /^\|?[\s:-]+\|/.test(line)) continue
      const text = line.replace(/^[-*+]\s+/, '').replace(/^#{3,6}\s+/, '▸ ')
      bullets.push({ text: text.slice(0, 120), options: { bullet: /^[-*+]\s+/.test(raw), fontSize: 14 } })
    }
    if (bullets.length) {
      slide.addText(
        bullets.map((b2) => ({ text: b2.text, options: b2.options })),
        { x: 0.6, y: 1.3, w: 8.8, h: 4.4, fontSize: 14, color: '374151', lineSpacingMultiple: 1.3, valign: 'top' },
      )
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
