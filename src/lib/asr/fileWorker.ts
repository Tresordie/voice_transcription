// 文件转写 Worker 桥接：WASM 解码全部在 Worker 中执行（public/asr-file-worker.js），
// 主线程只负责编排与进度展示——转写期间 UI 不再被解码阻塞（修复鼠标移动/切页卡顿）
import { SENSEVOICE_OFFLINE, ZIPFORMER_ZH_EN } from '../models/catalog'

export type FileEngine = 'offline' | 'local'

export interface FileTranscribeOpts {
  /** 解码进度（离线按 30s 块、流式按秒） */
  onProgress?: (done: number, total: number) => void
  /** 阶段文案（引擎加载/初始化等） */
  onStage?: (message: string) => void
}

interface WorkerMsg {
  type: 'stage' | 'progress' | 'result' | 'error'
  message?: string
  done?: number
  total?: number
  text?: string
}

let worker: Worker | null = null
// 当前在途任务（Worker 内任务串行执行，桥接同样串行下发，协议按"单一在途任务"设计）
let current: {
  resolve: (text: string) => void
  reject: (e: Error) => void
  opts: FileTranscribeOpts
} | null = null
// 串行化链：多个附件同时提取时逐个转写
let chain: Promise<unknown> = Promise.resolve()

function attachHandlers(w: Worker): void {
  w.onmessage = (e: MessageEvent<WorkerMsg>) => {
    const m = e.data
    const cur = current
    if (!cur) return
    if (m.type === 'stage') cur.opts.onStage?.(m.message ?? '')
    else if (m.type === 'progress') cur.opts.onProgress?.(m.done ?? 0, m.total ?? 0)
    else if (m.type === 'result') {
      current = null
      cur.resolve(m.text ?? '')
    } else if (m.type === 'error') {
      current = null
      cur.reject(new Error(m.message || '转写失败'))
    }
  }
  w.onerror = (e) => {
    // 脚本加载失败等致命错误：丢弃实例，下次调用重建
    worker = null
    const cur = current
    current = null
    cur?.reject(new Error(`转写 Worker 异常：${e.message || '未知错误'}`))
  }
}

function getWorker(): Worker {
  if (worker) return worker
  const w = new Worker(`${import.meta.env.BASE_URL}asr-file-worker.js`)
  attachHandlers(w)
  worker = w
  return w
}

function runJob(engine: FileEngine, pcm: Int16Array, language: string, opts: FileTranscribeOpts): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const w = getWorker()
    current = { resolve, reject, opts }
    const runtimeBase = `${import.meta.env.BASE_URL}sherpa${engine === 'offline' ? '/offline' : ''}`
    const modelUrls = engine === 'offline' ? SENSEVOICE_OFFLINE.dataUrls : ZIPFORMER_ZH_EN.dataUrls
    // pcm.buffer 以 transferable 下发（零拷贝）；调用方此后不得再使用该 buffer
    w.postMessage({ type: 'transcribe', engine, pcm: pcm.buffer, language, runtimeBase, modelUrls }, [pcm.buffer])
  })
}

/**
 * 在 Worker 中执行本地文件转写（offline = SenseVoice 非流式，local = Zipformer 流式）。
 * 16kHz Int16 PCM 入参；pcm.buffer 会被 transfer，调用后原 buffer 不可再用。
 * 多任务自动串行排队。
 */
export function transcribeInWorker(
  engine: FileEngine,
  pcm: Int16Array,
  language = '',
  opts: FileTranscribeOpts = {},
): Promise<string> {
  const job = chain.then(() => runJob(engine, pcm, language, opts))
  // 失败不阻断后续排队任务
  chain = job.catch(() => {})
  return job
}
