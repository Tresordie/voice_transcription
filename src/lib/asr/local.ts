// 本地引擎：sherpa-onnx WASM（官方 streaming zipformer 中英双语 int8）
//
// 架构：
//  - 运行时（glue + wasm + wrapper）内置在 /public/sherpa/
//  - 模型 .data（约 190MB）首次使用时下载 → Cache API 缓存 → blob URL
//  - emscripten glue 为非模块化构建：先挂全局 Module（locateFile 指向 .data 的
//    blob URL），再注入 <script> 加载 glue，onRuntimeInitialized 后创建识别器
import { useSyncExternalStore } from 'react'
import { fixLocalCase } from './case'
import { ZIPFORMER_ZH_EN } from '../models/catalog'
import { cachedBlobUrl, cachedSize, deleteCached, isCached, type DownloadProgress } from '../models/downloader'

// ---------- 全局类型（由 public/sherpa/sherpa-onnx-asr.js 的 epilogue 挂载） ----------
interface SherpaOnlineStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void
  inputFinished(): void
  free(): void
}
interface SherpaRecognizerResult {
  text: string
}
interface SherpaOnlineRecognizer {
  createStream(): SherpaOnlineStream
  isReady(stream: SherpaOnlineStream): boolean
  decode(stream: SherpaOnlineStream): void
  isEndpoint(stream: SherpaOnlineStream): boolean
  reset(stream: SherpaOnlineStream): void
  getResult(stream: SherpaOnlineStream): SherpaRecognizerResult
  free(): void
  config: { modelConfig: Record<string, unknown> }
}
interface SherpaModule {
  locateFile?: (path: string, dir?: string) => string
  setStatus?: (s: string) => void
  onRuntimeInitialized?: () => void
  _malloc: (n: number) => number
  _free: (p: number) => void
}
declare global {
  interface Window {
    SherpaOnnxASR?: {
      createOnlineRecognizer: (Module: SherpaModule) => SherpaOnlineRecognizer
      OnlineRecognizer: new (cfg: unknown, Module: SherpaModule) => SherpaOnlineRecognizer
      OfflineRecognizer: new (cfg: unknown, Module: SherpaModule) => unknown
      OnlineStream: new (handle: unknown, Module: SherpaModule) => SherpaOnlineStream
      OfflineStream: new (handle: unknown, Module: SherpaModule) => unknown
    }
    Module?: SherpaModule
  }
}

// ---------- 全局状态（供 React 订阅渲染） ----------
export type LocalStatus = 'no-model' | 'downloading' | 'loading' | 'ready' | 'error'

export interface LocalEngineState {
  status: LocalStatus
  /** 下载进度（字节） */
  received: number
  total: number
  /** 状态文案 */
  message: string
}

export const localEngineState: LocalEngineState = {
  status: 'no-model',
  received: 0,
  total: ZIPFORMER_ZH_EN.dataBytes,
  message: '',
}

let version = 0
const listeners = new Set<() => void>()
function notify(): void {
  version++
  listeners.forEach((l) => l())
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function getSnapshot(): number {
  return version
}

/** React hook：本地引擎状态变化时触发重渲染 */
export function useLocalEngineVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot)
}

function setState(patch: Partial<LocalEngineState>): void {
  Object.assign(localEngineState, patch)
  notify()
}

// ---------- 引擎实现 ----------
let modulePromise: Promise<SherpaModule> | null = null
let abortController: AbortController | null = null

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`脚本加载失败: ${src}`))
    document.head.appendChild(s)
  })
}

const RUNTIME_BASE = `${import.meta.env.BASE_URL}sherpa`

async function initModule(dataBlobUrl: string): Promise<SherpaModule> {
  if (!window.SherpaOnnxASR) {
    await loadScript(`${RUNTIME_BASE}/sherpa-onnx-asr.js`)
  }
  return new Promise<SherpaModule>((resolve, reject) => {
    const Module = {
      locateFile: (path: string) =>
        path.endsWith('.data') ? dataBlobUrl : `${RUNTIME_BASE}/${path}`,
      setStatus: (s: string) => {
        if (s && /Downloading data/i.test(s)) setState({ message: '加载模型到内存…' })
      },
      onRuntimeInitialized: () => resolve(Module),
    } as SherpaModule
    window.Module = Module
    loadScript(`${RUNTIME_BASE}/sherpa-onnx-wasm-main-asr.js`).catch(reject)
    setTimeout(() => reject(new Error('WASM 初始化超时（2 分钟）')), 120000)
  })
}

/**
 * 确保本地引擎就绪：模型未缓存则自动下载（带进度），然后初始化 wasm。
 * 重复调用安全（单例）。
 */
export async function ensureLocalEngine(): Promise<SherpaModule> {
  if (modulePromise) return modulePromise

  modulePromise = (async () => {
    try {
      const cached = await isCached(ZIPFORMER_ZH_EN.dataUrls)
      if (!cached) {
        setState({ status: 'downloading', received: 0, total: ZIPFORMER_ZH_EN.dataBytes, message: '连接下载源…' })
        abortController = new AbortController()
      } else {
        setState({ status: 'loading', message: '从缓存加载模型…' })
      }

      const onProgress = (p: DownloadProgress) => {
        setState({ status: 'downloading', received: p.received, total: p.total, message: '下载模型中…' })
      }
      const blobUrl = await cachedBlobUrl(ZIPFORMER_ZH_EN.dataUrls, onProgress, abortController?.signal)

      setState({ status: 'loading', message: '初始化识别引擎…' })
      const mod = await initModule(blobUrl)
      URL.revokeObjectURL(blobUrl)
      setState({ status: 'ready', received: 0, total: 0, message: '本地引擎已就绪' })
      return mod
    } catch (e) {
      const err = e as Error
      const aborted = err.name === 'AbortError'
      modulePromise = null
      setState({
        status: 'error',
        message: aborted ? '下载已取消' : `本地引擎初始化失败：${err.message}`,
      })
      throw err
    } finally {
      abortController = null
    }
  })()
  return modulePromise
}

/** 取消正在进行的模型下载 */
export function cancelLocalDownload(): void {
  abortController?.abort()
}

/** 删除已缓存的模型 */
export async function removeLocalModel(): Promise<void> {
  await deleteCached(ZIPFORMER_ZH_EN.dataUrls)
  if (localEngineState.status === 'ready' || localEngineState.status === 'error') {
    // 运行时无法卸载 wasm，只能提示刷新页面
    setState({ status: 'error', message: '模型已删除，刷新页面后生效' })
  } else {
    setState({ status: 'no-model', message: '' })
  }
}

/** 模型是否已缓存 */
export async function localModelCached(): Promise<boolean> {
  return isCached(ZIPFORMER_ZH_EN.dataUrls)
}

/** 已缓存字节数 */
export async function localModelCachedSize(): Promise<number> {
  return cachedSize(ZIPFORMER_ZH_EN.dataUrls)
}

// ---------- 流式会话 ----------
export class LocalStreamSession {
  private recognizer: SherpaOnlineRecognizer
  private stream: SherpaOnlineStream

  /** endpoint 命中（句末停顿）时触发，文本已定稿 */
  onFinal?: (text: string) => void
  /** 每次解码后的实时部分结果 */
  onPartial?: (text: string) => void

  constructor(module: SherpaModule) {
    if (!window.SherpaOnnxASR) throw new Error('本地引擎未初始化')
    this.recognizer = window.SherpaOnnxASR.createOnlineRecognizer(module)
    this.stream = this.recognizer.createStream()
  }

  // 喂入 16kHz Int16 PCM
  feed(pcm16: Int16Array): void {
    const f32 = new Float32Array(pcm16.length)
    for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 32768
    this.stream.acceptWaveform(16000, f32)
    while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream)
    const partial = fixLocalCase(this.recognizer.getResult(this.stream).text)
    if (partial) this.onPartial?.(partial)
    if (this.recognizer.isEndpoint(this.stream)) {
      if (partial) this.onFinal?.(partial)
      this.recognizer.reset(this.stream)
    }
  }

  // 结束输入，返回未定稿的尾部文本
  finish(): string {
    const text = fixLocalCase((this.recognizer.getResult(this.stream).text || '').trim())
    this.stream.inputFinished()
    return text
  }

  dispose(): void {
    try {
      this.stream.free()
      this.recognizer.free()
    } catch {
      // 忽略重复释放
    }
  }
}

// ---------- 文件转写（本地） ----------
// 流式识别器处理整段音频：按 1s 喂入，收集 endpoint 定稿 + 尾部文本
export async function transcribePcmLocal(
  module: SherpaModule,
  pcm: Int16Array,
  sampleRate = 16000,
): Promise<string> {
  if (sampleRate !== 16000) throw new Error('本地引擎仅支持 16kHz PCM')
  const session = new LocalStreamSession(module)
  const finals: string[] = []
  let lastPartial = ''
  session.onFinal = (t) => {
    finals.push(t)
    lastPartial = ''
  }
  session.onPartial = (t) => {
    lastPartial = t
  }
  const chunk = 16000 // 1s
  for (let off = 0; off < pcm.length; off += chunk) {
    session.feed(pcm.subarray(off, Math.min(off + chunk, pcm.length)))
    // 让出主线程，避免长时间阻塞 UI
    await new Promise((r) => setTimeout(r, 0))
  }
  const tail = session.finish()
  session.dispose()
  return [...finals, tail, lastPartial].filter(Boolean).join('')
}
