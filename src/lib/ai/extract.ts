// 附件 → 纯文本提取：文本类直读；pdf/docx/xlsx/pptx 动态解析；音频走应用已有转写引擎
// 依赖均按需动态 import，不进首屏 chunk
import { transcribeFile, type OnlineConfig } from '../asr/online'
import { transcribePcmLocal } from '../asr/local'
import { offlineModelCached, transcribePcmOffline } from '../asr/offline'
import { decodeToPcm16k } from '../audio/wav'
import type { AppSettings } from '../store/settings'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

/** 单文件大小上限（用户要求 150MB） */
export const MAX_FILE_BYTES = 150 * 1024 * 1024

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'log', 'srt', 'vtt',
  'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'c', 'h', 'cpp', 'go', 'rs', 'html', 'xml', 'yml', 'yaml', 'sql',
])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'webm', 'flac'])

export interface ExtractProgress {
  stage: string
  done?: number
  total?: number
}

export type ExtractProgressFn = (p: ExtractProgress) => void

function fileExt(file: File): string {
  return (file.name.split('.').pop() ?? '').toLowerCase()
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// ---------- 各类型解析 ----------

async function extractPdf(file: File, onProgress: ExtractProgressFn): Promise<string> {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  const data = await file.arrayBuffer()
  const doc = await pdfjs.getDocument({ data }).promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    pages.push(
      tc.items
        .map((it) => ('str' in it ? it.str : ''))
        .join(' ')
        .trim(),
    )
    onProgress({ stage: `解析 PDF（${i}/${doc.numPages} 页）`, done: i, total: doc.numPages })
  }
  return pages.join('\n\n')
}

/** docx = zip 包内的 word/document.xml：按 <w:p> 段落聚合 <w:t> 文本 */
async function extractDocx(file: File): Promise<string> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  const xml = await zip.file('word/document.xml')?.async('string')
  if (!xml) throw new Error('docx 解析失败：缺少 word/document.xml（旧版 .doc 不支持，请另存为 .docx）')
  return xml
    .split(/<\/w:p>/)
    .map((p) =>
      (p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? [])
        .map((s) => decodeEntities(s.replace(/<[^>]+>/g, '')))
        .join(''),
    )
    .filter((t) => t.trim())
    .join('\n')
}

/** pptx = zip 包内 ppt/slides/slideN.xml：逐页聚合 <a:t> 文本 */
async function extractPptx(file: File): Promise<string> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)) - Number(b.match(/\d+/)))
  if (slides.length === 0) throw new Error('pptx 解析失败：未找到幻灯片内容')
  const parts: string[] = []
  for (let i = 0; i < slides.length; i++) {
    const xml = await zip.file(slides[i])?.async('string')
    const texts = (xml?.match(/<a:t>[^<]*<\/a:t>/g) ?? [])
      .map((s) => decodeEntities(s.replace(/<[^>]+>/g, '')))
      .filter((t) => t.trim())
    parts.push(`【第 ${i + 1} 页】\n${texts.join('\n')}`)
  }
  return parts.join('\n\n')
}

/** xlsx/xls：每个工作表转为制表符分隔文本 */
async function extractSheet(file: File): Promise<string> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
  const parts: string[] = []
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false }) as unknown[][]
    parts.push(`【工作表 ${name}】\n` + rows.map((r) => r.map((c) => String(c ?? '')).join('\t')).join('\n'))
  }
  return parts.join('\n\n')
}

/** 音频：在线走 transcribeFile 分段上传；本地优先 SenseVoice 离线，回落 Zipformer 流式 */
async function transcribeAudio(
  file: File,
  settings: AppSettings,
  onProgress: ExtractProgressFn,
  signal?: AbortSignal,
): Promise<string> {
  if (settings.engineMode === 'online') {
    const cfg: OnlineConfig = {
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      model: settings.model,
      language: settings.language,
      transport: settings.transport,
      hotwords: settings.hotwords,
    }
    return transcribeFile(file, cfg, {
      onProgress: (done, total) => onProgress({ stage: '音频转写中（在线分段上传）', done, total }),
      signal,
    })
  }
  onProgress({ stage: '解码音频…' })
  const { pcm } = await decodeToPcm16k(file)
  if (await offlineModelCached()) {
    return transcribePcmOffline(
      pcm,
      settings.language === 'auto' ? '' : settings.language,
      {
        onProgress: (done, total) => onProgress({ stage: '音频转写中（SenseVoice 高精度）', done, total }),
        onStage: (message) => onProgress({ stage: message }),
      },
    )
  }
  onProgress({ stage: '音频转写中（Zipformer 流式，耗时较长）' })
  return transcribePcmLocal(pcm, {
    onProgress: (done, total) => onProgress({ stage: '音频转写中（Zipformer 流式）', done, total }),
    onStage: (message) => onProgress({ stage: message }),
  })
}

// ---------- 主入口 ----------

export async function extractFromFile(
  file: File,
  settings: AppSettings,
  onProgress: ExtractProgressFn = () => {},
  signal?: AbortSignal,
): Promise<string> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`文件超过 150MB 上限（当前 ${Math.ceil(file.size / 1048576)}MB）`)
  }
  const ext = fileExt(file)
  const isAudio = file.type.startsWith('audio/') || AUDIO_EXTS.has(ext)

  if (isAudio) {
    return transcribeAudio(file, settings, onProgress, signal)
  }
  if (ext === 'pdf' || file.type === 'application/pdf') {
    return extractPdf(file, onProgress)
  }
  if (ext === 'docx') {
    onProgress({ stage: '解析 Word 文档…' })
    return extractDocx(file)
  }
  if (ext === 'pptx') {
    onProgress({ stage: '解析 PPT…' })
    return extractPptx(file)
  }
  if (ext === 'xlsx' || ext === 'xls') {
    onProgress({ stage: '解析 Excel…' })
    return extractSheet(file)
  }
  if (TEXT_EXTS.has(ext) || file.type.startsWith('text/')) {
    onProgress({ stage: '读取文本…' })
    return file.text()
  }
  throw new Error(
    `暂不支持该文件类型（.${ext || '未知'}）。支持：txt/md/csv/pdf/docx/xlsx/pptx 与音频（mp3/wav/m4a 等）`,
  )
}
