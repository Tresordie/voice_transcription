// 本地高精度离线引擎：sherpa-onnx vad-asr WASM 构建 + SenseVoice（非流式）
//
// 与 local.ts（streaming zipformer，/sherpa/ 运行时）并存，专用于文件转写：
//  - 运行时内置于 /sherpa/offline/：自建 vad-asr 构建，开启 MODULARIZE（独立
//    factory，不与在线引擎的全局 Module 冲突）并导出 FS；.data 仅内置 tokens.txt
//  - SenseVoice int8 模型（约 228MB）运行时下载 → Cache API 缓存 → 写入 wasm
//    虚拟文件系统（FS.writeFile），无需重新加载 wasm 即可换模型
//  - 非流式解码：整段/分块一次性出字，中文准确率显著高于流式 zipformer，
//    且自带标点与数字规整（useInverseTextNormalization）
import { useSyncExternalStore } from 'react'
import { SENSEVOICE_OFFLINE } from '../models/catalog'
import { downloadWithProgress, deleteCached, isCached, cachedSize, type DownloadProgress } from '../models/downloader'
import { transcribeInWorker } from './fileWorker'

// ---------- 全局类型 ----------
// wrapper（/sherpa/offline/sherpa-onnx-asr.js，IIFE 隔离版）暴露到 window.SherpaOnnxOfflineNS
export interface SherpaOfflineStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void
  free(): void
}
export interface SherpaOfflineRecognizer {
  createStream(): SherpaOfflineStream
  decode(stream: SherpaOfflineStream): void
  /** 返回 JSON 解析后的结果：{ text, timestamps, tokens, lang, emotion, event } */
  getResult(stream: SherpaOfflineStream): { text?: string }
  free(): void
}
interface SherpaOfflineFS {
  writeFile(path: string, data: Uint8Array): void
  analyzePath(path: string): { exists: boolean }
}
export interface SherpaOfflineModule {
  FS: SherpaOfflineFS
  setStatus?: (s: string) => void
}
type SherpaVadAsrFactory = (args?: {
  locateFile?: (path: string) => string
  onRuntimeInitialized?: () => void
  setStatus?: (s: string) => void
}) => SherpaOfflineModule & PromiseLike<SherpaOfflineModule>

declare global {
  interface Window {
    SherpaOnnxVadAsrModule?: SherpaVadAsrFactory
    SherpaOnnxOfflineNS?: {
      OfflineRecognizer: new (cfg: unknown, module: SherpaOfflineModule) => SherpaOfflineRecognizer
      OfflineStream: new (handle: unknown, module: SherpaOfflineModule) => SherpaOfflineStream
    }
  }
}

// ---------- 状态（供 React 订阅渲染，结构与 local.ts 对齐） ----------
export type OfflineStatus = 'no-model' | 'downloading' | 'loading' | 'ready' | 'error'

export interface OfflineEngineState {
  status: OfflineStatus
  received: number
  total: number
  message: string
}

export const offlineEngineState: OfflineEngineState = {
  status: 'no-model',
  received: 0,
  total: SENSEVOICE_OFFLINE.dataBytes,
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

/** React hook：离线引擎状态变化时触发重渲染 */
export function useOfflineEngineVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot)
}

function setState(patch: Partial<OfflineEngineState>): void {
  Object.assign(offlineEngineState, patch)
  notify()
}

// ---------- 引擎实现 ----------
const RUNTIME_BASE = `${import.meta.env.BASE_URL}sherpa/offline`
const MODEL_PATH = '/sense-voice.onnx'

let modulePromise: Promise<SherpaOfflineModule> | null = null
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

async function initModule(): Promise<SherpaOfflineModule> {
  if (!window.SherpaOnnxOfflineNS) {
    await loadScript(`${RUNTIME_BASE}/sherpa-onnx-asr.js`)
  }
  if (!window.SherpaOnnxVadAsrModule) {
    // MODULARIZE 构建：先加载 glue 挂载全局 factory，再实例化
    await loadScript(`${RUNTIME_BASE}/sherpa-onnx-wasm-main-vad-asr.js`)
  }
  const factory = window.SherpaOnnxVadAsrModule
  if (!factory) throw new Error('离线引擎运行时缺失（/sherpa/offline/）')
  return new Promise<SherpaOfflineModule>((resolve, reject) => {
    let settled = false
    const mod = factory({
      locateFile: (path) => `${RUNTIME_BASE}/${path}`,
      setStatus: (s) => {
        if (s && /Downloading data/i.test(s)) setState({ message: '加载运行时资源…' })
      },
      onRuntimeInitialized: () => {
        if (!settled) {
          settled = true
          resolve(mod)
        }
      },
    })
    // MODULARIZE 构建返回 Promise-like 实例，双通道等待先到者胜
    Promise.resolve(mod).then((m) => {
      if (!settled) {
        settled = true
        resolve(m)
      }
    })
    setTimeout(() => reject(new Error('离线引擎初始化超时')), 60000)
  })
}

/**
 * 确保离线引擎就绪：模型未缓存则自动下载（带进度），初始化 wasm 并把模型
 * 写入虚拟文件系统。重复调用安全（单例）。
 */
export async function ensureOfflineEngine(): Promise<SherpaOfflineModule> {
  if (modulePromise) return modulePromise

  modulePromise = (async () => {
    try {
      const cached = await isCached(SENSEVOICE_OFFLINE.dataUrls)
      if (!cached) {
        setState({ status: 'downloading', received: 0, total: SENSEVOICE_OFFLINE.dataBytes, message: '连接下载源…' })
        abortController = new AbortController()
      } else {
        setState({ status: 'loading', message: '从缓存加载模型…' })
      }

      const onProgress = (p: DownloadProgress) => {
        setState({ status: 'downloading', received: p.received, total: p.total, message: '下载模型中…' })
      }
      const res = await downloadWithProgress(SENSEVOICE_OFFLINE.dataUrls, onProgress, abortController?.signal)

      setState({ status: 'loading', message: '初始化识别引擎…' })
      const mod = await initModule()

      setState({ message: '写入模型到内存…' })
      if (!mod.FS.analyzePath(MODEL_PATH).exists) {
        const bytes = new Uint8Array(await res.arrayBuffer())
        mod.FS.writeFile(MODEL_PATH, bytes)
      }

      setState({ status: 'ready', received: 0, total: 0, message: '离线引擎已就绪' })
      return mod
    } catch (e) {
      const err = e as Error
      const aborted = err.name === 'AbortError'
      modulePromise = null
      setState({
        status: 'error',
        message: aborted ? '下载已取消' : `离线引擎初始化失败：${err.message}`,
      })
      throw err
    } finally {
      abortController = null
    }
  })()
  return modulePromise
}

/** 取消正在进行的模型下载 */
export function cancelOfflineDownload(): void {
  abortController?.abort()
}

/** 删除已缓存的模型 */
export async function removeOfflineModel(): Promise<void> {
  await deleteCached(SENSEVOICE_OFFLINE.dataUrls)
  if (offlineEngineState.status === 'ready' || offlineEngineState.status === 'error') {
    // 运行时无法卸载 wasm 与已写入的 MEMFS，只能提示刷新页面
    setState({ status: 'error', message: '模型已删除，刷新页面后生效' })
  } else {
    setState({ status: 'no-model', message: '' })
  }
}

/** 模型是否已缓存 */
export async function offlineModelCached(): Promise<boolean> {
  return isCached(SENSEVOICE_OFFLINE.dataUrls)
}

/** 已缓存字节数 */
export async function offlineModelCachedSize(): Promise<number> {
  return cachedSize(SENSEVOICE_OFFLINE.dataUrls)
}

// ---------- 文件转写（本地离线） ----------

/**
 * 非流式整段转写：按 30s 分块顺序解码并拼接（ SenseVoice 设计时长为短音频，
 * 过长分段会显著拖慢且影响标点质量）。
 * 解码在文件转写 Worker 中执行（WASM 解码不再阻塞主线程 UI）；
 * 模型须已缓存（调用方以 offlineModelCached() 预检），Worker 从 Cache API 读取。
 * language: 'auto' 传空串（模型自动检测），'zh'/'en' 直传。
 */
export async function transcribePcmOffline(
  pcm: Int16Array,
  language = '',
  opts: {
    onProgress?: (done: number, total: number) => void
    onStage?: (message: string) => void
  } = {},
): Promise<string> {
  return transcribeInWorker('offline', pcm, language, opts)
}
