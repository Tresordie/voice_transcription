// OpenAI 兼容语音识别客户端（POST /v1/audio/transcriptions）
import { decodeToPcm16k, encodeWav } from '../audio/wav'

export type ProviderId = 'openai' | 'groq' | 'siliconflow' | 'custom'

export interface ProviderPreset {
  id: ProviderId
  label: string
  baseURL: string
  models: string[]
  keyUrl: string
  note: string
}

export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    models: ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'],
    keyUrl: 'https://platform.openai.com/api-keys',
    note: '综合效果极强，中文良好；需海外网络环境',
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    models: ['whisper-large-v3', 'whisper-large-v3-turbo'],
    keyUrl: 'https://console.groq.com/keys',
    note: 'whisper-large-v3 速度快、免费额度充足；需海外网络环境',
  },
  siliconflow: {
    id: 'siliconflow',
    label: '硅基流动',
    baseURL: 'https://api.siliconflow.cn/v1',
    models: ['FunAudioLLM/SenseVoiceSmall', 'TeleAI/TeleSpeechASR'],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: 'SenseVoiceSmall 完全免费、中文效果好、国内直连',
  },
  custom: {
    id: 'custom',
    label: '自定义',
    baseURL: '',
    models: [],
    keyUrl: '',
    note: '任意兼容 OpenAI /audio/transcriptions 格式的服务',
  },
}

export interface OnlineConfig {
  baseURL: string
  apiKey: string
  model: string
  language?: string
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

// 单段转写：直接把音频 blob 发给 /audio/transcriptions
export async function transcribeBlob(
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
    throw new OnlineError(
      '网络请求失败：可能是浏览器直连被 CORS 拦截。可换用支持直连的服务商（如硅基流动），' +
        '或运行 `npm run proxy` 后把 Base URL 改为 http://localhost:8787/proxy/<服务商BaseURL>',
    )
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
