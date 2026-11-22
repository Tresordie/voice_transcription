// OpenAI 兼容语音识别客户端（POST /v1/audio/transcriptions）
import { decodeToPcm16k, encodeWav } from '../audio/wav'

export type ProviderId = 'siliconflow' | 'bailian' | 'custom'

/** 在线转写的两种协议 */
export type Transport = 'transcriptions' | 'qwen-chat'

export interface ProviderPreset {
  id: ProviderId
  label: string
  baseURL: string
  models: string[]
  keyUrl: string
  note: string
  /** 该服务商使用的请求协议，默认 OpenAI /audio/transcriptions */
  transport?: Transport
}

export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  siliconflow: {
    id: 'siliconflow',
    label: '硅基流动',
    baseURL: 'https://api.siliconflow.cn/v1',
    models: ['FunAudioLLM/SenseVoiceSmall'],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: 'SenseVoiceSmall 完全免费、中文效果好、国内直连',
  },
  bailian: {
    id: 'bailian',
    label: '阿里百炼',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3-asr-flash'],
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1#/api-key',
    note: 'qwen3-asr-flash 中文准确率高、支持方言；北京地域有免费额度（90 天）。必须走内置代理；订阅制 Token Plan 端点不支持语音识别，请勿使用',
  },
  custom: {
    id: 'custom',
    label: '自定义',
    baseURL: '',
    models: [],
    keyUrl: '',
    note: '任意兼容 OpenAI /audio/transcriptions 格式的服务；阿里云百炼域名（dashscope/maas.aliyuncs.com）会自动识别为 Qwen-ASR 协议',
  },
}

export interface OnlineConfig {
  baseURL: string
  apiKey: string
  model: string
  language?: string
  /** 请求协议，默认 transcriptions */
  transport?: Transport
  /** 热词/上下文：提高专有名词准确率（Qwen-ASR 作 system context，OpenAI 兼容作 prompt） */
  hotwords?: string
}

export class OnlineError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

function endpoint(cfg: OnlineConfig): string {
  return `${cfg.baseURL.replace(/\/+$/, '')}/audio/transcriptions`
}

// 单段转写：按 transport 分发到对应协议。
// 协议跟 URL 自动匹配：阿里百炼域名（dashscope/maas.aliyuncs.com）强制 qwen-chat，
// 硅基流动域名强制标准 transcriptions，其余按设置值——用户无论怎么改都不会配错。
export async function transcribeBlob(
  blob: Blob,
  filename: string,
  cfg: OnlineConfig,
  signal?: AbortSignal,
): Promise<string> {
  let transport: Transport = cfg.transport ?? 'transcriptions'
  if (/(dashscope|maas)\.aliyuncs\.com/i.test(cfg.baseURL)) {
    transport = 'qwen-chat'
  } else if (/siliconflow\.(cn|com)/i.test(cfg.baseURL)) {
    transport = 'transcriptions'
  }
  if (transport === 'qwen-chat') {
    return transcribeQwenChat(blob, filename, cfg, signal)
  }
  return transcribeTranscriptions(blob, filename, cfg, signal)
}

/** URL 是否为阿里百炼域名且未走代理（用于设置页的提醒） */
export function needsProxyHint(baseURL: string): boolean {
  return (
    /(dashscope|maas)\.aliyuncs\.com/i.test(baseURL) &&
    !/\/proxy\//.test(baseURL)
  )
}

/** 把裸百炼地址包装为内置代理地址 */
export function withDevProxy(baseURL: string): string {
  return `http://localhost:5173/proxy/${baseURL}`
}

// OpenAI 标准 /audio/transcriptions（multipart 文件上传）
async function transcribeTranscriptions(
  blob: Blob,
  filename: string,
  cfg: OnlineConfig,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData()
  form.append('file', new File([blob], filename, { type: blob.type || 'audio/wav' }))
  form.append('model', cfg.model)
  form.append('response_format', 'json')
  if (cfg.language && cfg.language !== 'auto') form.append('language', cfg.language)
  if (cfg.hotwords?.trim()) form.append('prompt', cfg.hotwords.trim())

  let res: Response
  try {
    res = await fetch(endpoint(cfg), {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      signal,
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw networkError()
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new OnlineError(
      `接口返回 ${res.status}${res.status === 401 ? '（鉴权失败，请检查 API Key）' : ''}：${text.slice(0, 300) || res.statusText}`,
      res.status,
    )
  }
  const data = await res.json()
  return (data.text ?? '') as string
}

// 阿里百炼 Qwen-ASR：chat/completions + input_audio。
// 不同代际模型（qwen3-asr-flash / qwen-audio-3.0-asr-flash …）对字段格式要求略有差异，
// 因此自动依次尝试多种形态，成功即用；全失败时聚合各形态的返回便于定位。
const QWEN_INPUT_VARIANTS = [
  // 1. OpenAI 镜像格式：Data URI + format
  (dataUrl: string, _raw: string, fmt: string) => ({ data: dataUrl, format: fmt }),
  // 2. Data URI（无 format）
  (dataUrl: string) => ({ data: dataUrl }),
  // 3. 裸 Base64 + format
  (_dataUrl: string, raw: string, fmt: string) => ({ data: raw, format: fmt }),
  // 4. 裸 Base64
  (_dataUrl: string, raw: string) => ({ data: raw }),
]

async function transcribeQwenChat(
  blob: Blob,
  filename: string,
  cfg: OnlineConfig,
  signal?: AbortSignal,
): Promise<string> {
  const dataUrl = await blobToDataUrl(blob)
  const rawB64 = dataUrl.slice(Math.max(0, dataUrl.indexOf(',') + 1))
  const fmt = blob.type.includes('mp3') ? 'mp3' : 'wav'
  const url = `${cfg.baseURL.replace(/\/+$/, '')}/chat/completions`
  const attempts: string[] = []
  let requestId = ''

  const buildBody = (inputAudio: unknown) => {
    const messages: Array<{ role: string; content: unknown }> = []
    // 官方约定：system message 仅用于提供识别上下文（背景文本、实体词表）
    if (cfg.hotwords?.trim()) messages.push({ role: 'system', content: cfg.hotwords.trim() })
    messages.push({
      role: 'user',
      content: [{ type: 'input_audio', input_audio: inputAudio }],
    })
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
    }
    // 中英混说时不要指定 language；用户明确选了语种才传（非标准字段）
    if (cfg.language && cfg.language !== 'auto') body.asr_options = { language: cfg.language }
    return body
  }

  // 形态 1-4：chat/completions 的 input_audio 字段变体
  for (let v = 0; v < QWEN_INPUT_VARIANTS.length; v++) {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildBody(QWEN_INPUT_VARIANTS[v](dataUrl, rawB64, fmt))),
        signal,
      })
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e
      throw networkError()
    }
    requestId = res.headers.get('x-request-id') ?? requestId
    const text = await res.text().catch(() => '')
    if (res.ok) return parseQwenChatResponse(text)
    attempts.push(`形态${v + 1}: HTTP ${res.status} ${text.slice(0, 100)}`)
    // 401/403/404/5xx 等换形态无意义，只有 400（参数体校验）值得继续尝试
    if (res.status !== 400) break
  }

  // 形态 5：该端点也可能支持标准 /audio/transcriptions（multipart）
  try {
    return await transcribeTranscriptions(blob, filename, cfg, signal)
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    const m = (e as Error).message.match(/HTTP (\d+)/)
    attempts.push(`形态5(transcriptions): ${m?.[1] ?? ''} ${(e as Error).message.slice(0, 100)}`)
  }

  // 形态 6：DashScope 原生 multimodal-generation 协议
  // （Qwen-Audio 旧代际模型不支持 OpenAI 兼容协议，仅支持此协议，路径与 compatible-mode 同域不同路径）
  if (/compatible-mode/i.test(cfg.baseURL)) {
    const nativeBase = cfg.baseURL.replace(/\/compatible-mode\/v\d+.*$/, '')
    const nativeUrl = `${nativeBase}/api/v1/services/aigc/multimodal-generation/generation`
    const nativeBody: Record<string, unknown> = {
      model: cfg.model,
      input: {
        messages: [
          ...(cfg.hotwords?.trim() ? [{ role: 'system', content: cfg.hotwords.trim() }] : []),
          { role: 'user', content: [{ audio: dataUrl }] },
        ],
      },
    }
    if (cfg.language && cfg.language !== 'auto') {
      nativeBody.parameters = { asr_options: { language: cfg.language } }
    }
    let res: Response
    try {
      res = await fetch(nativeUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(nativeBody),
        signal,
      })
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e
      throw networkError()
    }
    requestId = res.headers.get('x-request-id') ?? requestId
    const text = await res.text().catch(() => '')
    if (res.ok) return parseQwenChatResponse(text)
    attempts.push(`形态6(native): HTTP ${res.status} ${text.slice(0, 100)}`)
    if (res.status !== 400) {
      throw new OnlineError(
        `百炼接口尝试 ${attempts.length} 种请求形态后停止：${attempts.join('；')}${requestId ? `（request-id: ${requestId}）` : ''}。` +
          '请到百炼控制台该模型页面复制「调用示例」核对协议，或确认模型已在当前工作区开通',
      )
    }
  }

  const reqId = requestId ? `（request-id: ${requestId}）` : ''
  throw new OnlineError(
    `百炼接口对全部 ${attempts.length} 种请求形态均返回错误：${attempts.join('；')}${reqId}。` +
      '请到百炼控制台该模型页面复制「调用示例」核对协议，或确认模型已在当前工作区开通',
  )
}

function parseQwenChatResponse(text: string): string {
  let data: {
    choices?: Array<{ message?: { content?: unknown } }>
    output?: {
      text?: unknown
      choices?: Array<{ message?: { content?: unknown } }>
    }
    text?: unknown
  }
  try {
    data = JSON.parse(text)
  } catch {
    return text.trim()
  }
  // OpenAI 兼容形态：choices[].message.content
  const msg = data?.choices?.[0]?.message
  if (msg) {
    if (typeof msg.content === 'string') return msg.content.trim()
    if (Array.isArray(msg.content)) {
      return (msg.content as Array<{ text?: string }>).map((p) => p?.text ?? '').join('').trim()
    }
  }
  // DashScope 原生形态：output.choices[].message.content 或 output.text
  const nativeMsg = data?.output?.choices?.[0]?.message
  if (nativeMsg) {
    if (typeof nativeMsg.content === 'string') return nativeMsg.content.trim()
    if (Array.isArray(nativeMsg.content)) {
      return (nativeMsg.content as Array<{ text?: string }>).map((p) => p?.text ?? '').join('').trim()
    }
  }
  return String(data?.output?.text ?? data?.text ?? '').trim()
}

function networkError(): OnlineError {
  return new OnlineError(
    '网络请求失败：该服务商未开放浏览器 CORS 权限。开发模式下把 Base URL 改为 ' +
      'http://localhost:5173/proxy/<服务商BaseURL>（内置代理）；独立部署时运行 npm run proxy，' +
      '改用 http://localhost:8787/proxy/<服务商BaseURL>',
  )
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(new Error('音频读取失败'))
    r.readAsDataURL(blob)
  })
}

// 英文片段之间补空格，中文直接拼接
export function joinParts(parts: string[]): string {
  let out = ''
  for (const p of parts) {
    if (!p) continue
    if (!out) {
      out = p
      continue
    }
    const last = out[out.length - 1]
    const needSpace = /[a-zA-Z0-9,.!?;:]$/.test(last) && /^[a-zA-Z0-9(]/.test(p)
    out += (needSpace ? ' ' : '') + p
  }
  return out
}

// 文件转写：解码 → 16kHz → 按 60s 分段顺序转写并拼接
// （统一走解码分段，顺便把 m4a/webm 等格式归一成 wav，规避服务商格式限制）
export async function transcribeFile(
  file: Blob,
  cfg: OnlineConfig,
  opts: {
    onProgress?: (done: number, total: number) => void
    signal?: AbortSignal
    chunkSec?: number
  } = {},
): Promise<string> {
  const { pcm, sampleRate } = await decodeToPcm16k(file)
  const chunkSamples = (opts.chunkSec ?? 60) * sampleRate
  const totalChunks = Math.max(1, Math.ceil(pcm.length / chunkSamples))
  const parts: string[] = []
  for (let i = 0; i < totalChunks; i++) {
    const seg = pcm.subarray(i * chunkSamples, (i + 1) * chunkSamples)
    const wav = encodeWav(seg, sampleRate)
    try {
      parts.push(await transcribeBlob(wav, `chunk-${i}.wav`, cfg, opts.signal))
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e
      // 单段失败跳过，不中断整体
      parts.push('')
    }
    opts.onProgress?.(i + 1, totalChunks)
  }
  return joinParts(parts)
}

// 连接测试：发送 0.5s 440Hz 正弦波（部分云端 ASR 拒绝纯静音音频）
export async function testOnline(cfg: OnlineConfig): Promise<{ ok: boolean; message: string }> {
  if (!cfg.baseURL || !cfg.apiKey || !cfg.model) {
    return { ok: false, message: '请先完整填写 Base URL、API Key 和模型名' }
  }
  const sr = 16000
  const pcm = new Int16Array(sr / 2)
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 12000)
  }
  const wav = encodeWav(pcm, sr)
  try {
    await transcribeBlob(wav, 'test.wav', cfg)
    return { ok: true, message: '连接成功：接口可达、鉴权通过' }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}
