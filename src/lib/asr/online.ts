// OpenAI 兼容语音识别客户端（POST /v1/audio/transcriptions）
import { decodeToPcm16k, encodeWav } from '../audio/wav'

export type ProviderId = 'siliconflow' | 'dashscope' | 'custom'

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
    models: ['FunAudioLLM/SenseVoiceSmall', 'TeleAI/TeleSpeechASR'],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: 'SenseVoiceSmall 完全免费、中文效果好、国内直连',
  },
  dashscope: {
    id: 'dashscope',
    label: '阿里百炼 Qwen-ASR',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3-asr-flash'],
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1#/api-key',
    note: '国内第一梯队准确率，支持 26 语种；浏览器直连被 CORS 拦截时需先运行 npm run proxy，Base URL 改为 http://localhost:8787/proxy/<百炼地址>（Token 计划用户填自己的专属 maas 域名）',
    transport: 'qwen-chat',
  },
  custom: {
    id: 'custom',
    label: '自定义',
    baseURL: '',
    models: [],
    keyUrl: '',
    note: '任意兼容 OpenAI /audio/transcriptions 格式的服务（火山引擎等可通过代理或适配接入）',
  },
}

export interface OnlineConfig {
  baseURL: string
  apiKey: string
  model: string
  language?: string
  /** 请求协议，默认 transcriptions */
  transport?: Transport
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

// 单段转写：按 transport 分发到对应协议
export async function transcribeBlob(
  blob: Blob,
  filename: string,
  cfg: OnlineConfig,
  signal?: AbortSignal,
): Promise<string> {
  if (cfg.transport === 'qwen-chat') {
    return transcribeQwenChat(blob, cfg, signal)
  }
  return transcribeTranscriptions(blob, filename, cfg, signal)
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

// 阿里百炼 Qwen-ASR：chat/completions + input_audio（Base64 Data URI）
// 文档：https://www.alibabacloud.com/help/zh/model-studio/qwen-asr-api-reference
async function transcribeQwenChat(
  blob: Blob,
  cfg: OnlineConfig,
  signal?: AbortSignal,
): Promise<string> {
  const dataUrl = await blobToDataUrl(blob)
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      {
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: dataUrl } }],
      },
    ],
  }
  // 中英混说时不要指定 language；用户明确选了语种才传（非标准字段）
  if (cfg.language && cfg.language !== 'auto') {
    body.asr_options = { language: cfg.language }
  }

  const url = `${cfg.baseURL.replace(/\/+$/, '')}/chat/completions`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
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
  // 兼容多种返回形态：choices[].message.content（字符串或分片数组）、data.text
  const msg = data?.choices?.[0]?.message
  let text = ''
  if (typeof msg?.content === 'string') {
    text = msg.content
  } else if (Array.isArray(msg?.content)) {
    text = msg.content.map((p: { text?: string }) => p?.text ?? '').join('')
  } else {
    text = data?.text ?? data?.output?.text ?? ''
  }
  return String(text).trim()
}

function networkError(): OnlineError {
  return new OnlineError(
    '网络请求失败：该服务商未开放浏览器 CORS 权限。请先运行 `npm run proxy` 启动本地代理，' +
      '再把 Base URL 改为 http://localhost:8787/proxy/<服务商BaseURL>',
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

// 连接测试：发送 0.5s 静音音频
export async function testOnline(cfg: OnlineConfig): Promise<{ ok: boolean; message: string }> {
  if (!cfg.baseURL || !cfg.apiKey || !cfg.model) {
    return { ok: false, message: '请先完整填写 Base URL、API Key 和模型名' }
  }
  const wav = encodeWav(new Int16Array(8000), 16000) // 0.5s @16kHz
  try {
    await transcribeBlob(wav, 'test.wav', cfg)
    return { ok: true, message: '连接成功：接口可达、鉴权通过' }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}
