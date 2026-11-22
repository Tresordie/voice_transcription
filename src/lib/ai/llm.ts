// AI 总结：OpenAI 兼容 chat/completions 客户端（非流式 + SSE 流式）
// 复用应用约定：Base URL 可填 /proxy/<目标> 前缀绕过未开放 CORS 的服务商

export interface LlmConfig {
  baseURL: string
  apiKey: string
  model: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  /** 流式输出：onDelta 逐段回调，最终返回完整文本 */
  stream?: boolean
  onDelta?: (delta: string, full: string) => void
  signal?: AbortSignal
  maxTokens?: number
  temperature?: number
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

function endpoint(cfg: LlmConfig): string {
  return `${cfg.baseURL.replace(/\/+$/, '')}/chat/completions`
}

/** 解析 SSE 流（data: 行 → JSON delta），返回累计全文 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string, full: string) => void,
): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let full = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    // SSE 事件以空行分隔；逐行解析 data: 前缀
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const json = JSON.parse(payload)
        const delta: string = json.choices?.[0]?.delta?.content ?? ''
        if (delta) {
          full += delta
          onDelta(delta, full)
        }
      } catch {
        // 忽略无法解析的行（心跳/注释等）
      }
    }
  }
  return full
}

/**
 * 调用 OpenAI 兼容 chat/completions。stream=true 时通过 onDelta 流式回调，
 * 返回值始终是完整文本。
 */
export async function chatLLM(
  cfg: LlmConfig,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  if (!cfg.baseURL || !cfg.apiKey || !cfg.model) {
    throw new LlmError('请先在「设置」页填写 AI 总结服务的 Base URL、API Key 和模型名')
  }
  const stream = opts.stream ?? false
  let res: Response
  try {
    res = await fetch(endpoint(cfg), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        stream,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      }),
      signal: opts.signal,
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new LlmError(
      '网络请求失败：可能是该服务未开放浏览器 CORS 权限。' +
        '开发模式把 Base URL 改为 http://localhost:5173/proxy/<服务商BaseURL>（内置代理），' +
        '独立部署运行 npm run proxy 后用 http://localhost:8787/proxy/<服务商BaseURL>',
    )
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const brief = text.slice(0, 200) || res.statusText
    throw new LlmError(`接口返回 ${res.status}${res.status === 401 ? '（鉴权失败，请检查 API Key）' : ''}：${brief}`, res.status)
  }
  if (stream && res.body) {
    return readStream(res.body, opts.onDelta ?? (() => {}))
  }
  const data = await res.json()
  return String(data.choices?.[0]?.message?.content ?? '')
}
