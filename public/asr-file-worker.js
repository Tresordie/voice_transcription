// 文件转写 Worker：把 sherpa-onnx WASM 解码移出主线程，避免转写期间 UI 卡顿
// （离线 SenseVoice 每块解码阻塞数秒、流式 Zipformer 每秒阻塞百余毫秒，主线程无法抢占）
// 协议见 src/lib/asr/fileWorker.ts：
//   入 { type:'transcribe', engine:'offline'|'local', pcm:ArrayBuffer(transfer), language, runtimeBase, modelUrls }
//   出 { type:'stage'|'progress'|'result'|'error' }
// 本文件为经典 Worker 脚本（免打包，与 public/sherpa/ 运行时同源直载），保持原生 JS。

// 两个 wrapper 脚本按 window 挂载导出（window.SherpaOnnxOfflineNS / SherpaOnnxASR），Worker 中 shim 到自身
self.window = self

const CACHE_NAME = 'vt-model-cache' // 与 src/lib/models/downloader.ts 保持一致
const TOKENS_PATH = './tokens.txt' // 由运行时 .data 预加载挂载到根目录
const MODEL_PATH = '/sense-voice.onnx'

// ---------- 纯函数复刻（与主线程 src/lib/asr/online.ts / case.ts / offline.ts 保持一致） ----------

// SenseVoice 结果防御性剥离个别版本携带的 <|zh|> 等标记
function stripSenseTags(text) {
  return text.replace(/<\|[^|]*\|>/g, '').trim()
}

// 英文片段之间补空格，中文直接拼接
function joinParts(parts) {
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

// streaming zipformer 英文词表为全大写 BPE，检测到"绝大多数单词全大写"时转句子式大小写
function isMostlyUpper(text) {
  const words = text.match(/[A-Za-z']+/g) || []
  const counted = words.filter((w) => w.length >= 2)
  if (counted.length === 0) return false
  const upper = counted.filter((w) => w === w.toUpperCase()).length
  return upper / counted.length > 0.8
}

function sentenceCase(text) {
  let out = text.toLowerCase()
  // 句首（文本开头 / . ! ? 。 ！ ？ 换行 之后）字母大写
  out = out.replace(/(^|[.!?。！？]\s*|\n)([a-z])/g, (_m, pre, c) => pre + c.toUpperCase())
  // 独立的 "i" 恢复为 "I"
  out = out.replace(/\bi\b/g, 'I')
  return out
}

function fixLocalCase(text) {
  const t = text.trim()
  if (!t) return text
  return isMostlyUpper(t) ? sentenceCase(t) : text
}

// ---------- 公共辅助 ----------

function post(msg) {
  self.postMessage(msg)
}

function postStage(message) {
  post({ type: 'stage', message })
}

// 从 Cache API 读取模型（下载由主线程 ensureXXX 完成，Worker 只读缓存）
async function readCached(urls) {
  if (typeof caches === 'undefined') throw new Error('当前环境不支持 Cache API，无法在 Worker 中读取模型')
  const cache = await caches.open(CACHE_NAME)
  for (const url of urls) {
    const res = await cache.match(url)
    if (res) return res
  }
  throw new Error('模型缓存不存在，请先在「设置」页下载模型')
}

// ---------- 离线引擎（SenseVoice 非流式） ----------

let offlineMod = null // 复用 wasm 模块与已写入的模型（识别器随每次转写创建/释放，与主线程原实现一致）

async function ensureOfflineModule(runtimeBase, modelUrls) {
  if (offlineMod) return offlineMod
  postStage('加载离线引擎运行时…')
  importScripts(runtimeBase + '/sherpa-onnx-asr.js')
  importScripts(runtimeBase + '/sherpa-onnx-wasm-main-vad-asr.js')
  const factory = self.SherpaOnnxVadAsrModule
  if (!factory) throw new Error('离线引擎运行时缺失（' + runtimeBase + '/）')
  const mod = await new Promise((resolve, reject) => {
    let settled = false
    const settle = (m) => {
      if (settled) return
      settled = true
      resolve(m)
    }
    const m = factory({
      locateFile: (path) => runtimeBase + '/' + path,
      onRuntimeInitialized: () => settle(m),
    })
    // MODULARIZE 构建返回 Promise-like 实例，双通道等待先到者胜
    Promise.resolve(m).then(settle)
    setTimeout(() => settle(undefined), 60000)
  })
  if (!mod) throw new Error('离线引擎初始化超时')
  postStage('写入模型到内存…')
  if (!mod.FS.analyzePath(MODEL_PATH).exists) {
    const res = await readCached(modelUrls)
    const bytes = new Uint8Array(await res.arrayBuffer())
    mod.FS.writeFile(MODEL_PATH, bytes)
  }
  if (!self.SherpaOnnxOfflineNS) throw new Error('离线引擎 wrapper 未挂载')
  offlineMod = mod
  return mod
}

async function transcribeOffline(pcm, language, runtimeBase, modelUrls) {
  const mod = await ensureOfflineModule(runtimeBase, modelUrls)
  const NS = self.SherpaOnnxOfflineNS
  postStage('初始化 SenseVoice 识别器…')
  const recognizer = new NS.OfflineRecognizer(
    {
      modelConfig: {
        tokens: TOKENS_PATH,
        senseVoice: {
          model: MODEL_PATH,
          useInverseTextNormalization: 1,
          ...(language ? { language } : {}),
        },
        debug: 0,
      },
    },
    mod,
  )
  try {
    // 非流式整段转写：按 30s 分块顺序解码并拼接
    const chunkSamples = 30 * 16000
    const totalChunks = Math.max(1, Math.ceil(pcm.length / chunkSamples))
    const parts = []
    for (let i = 0; i < totalChunks; i++) {
      const seg = pcm.subarray(i * chunkSamples, Math.min((i + 1) * chunkSamples, pcm.length))
      const f32 = new Float32Array(seg.length)
      for (let j = 0; j < seg.length; j++) f32[j] = seg[j] / 32768
      const stream = recognizer.createStream()
      stream.acceptWaveform(16000, f32)
      recognizer.decode(stream)
      parts.push(stripSenseTags(recognizer.getResult(stream).text || ''))
      stream.free()
      post({ type: 'progress', done: i + 1, total: totalChunks })
    }
    post({ type: 'result', text: joinParts(parts) })
  } finally {
    recognizer.free()
  }
}

// ---------- 流式引擎（Zipformer 中英双语） ----------

let localMod = null // 复用 wasm 模块（识别器随每次转写创建/释放，与主线程原实现一致）

async function ensureLocalModule(runtimeBase, modelUrls) {
  if (localMod) return localMod
  postStage('加载流式引擎…')
  importScripts(runtimeBase + '/sherpa-onnx-asr.js') // wrapper 先挂载 SherpaOnnxASR
  // 模型 .data（约 190MB）：从缓存读出 → blob URL → locateFile
  const res = await readCached(modelUrls)
  const blobUrl = URL.createObjectURL(await res.blob())
  await new Promise((resolve, reject) => {
    let settled = false
    const Module = {
      locateFile: (path) => (path.endsWith('.data') ? blobUrl : runtimeBase + '/' + path),
      setStatus: (s) => {
        if (s && /Downloading data/i.test(s)) postStage('加载模型到内存…')
      },
      onRuntimeInitialized: () => {
        if (!settled) {
          settled = true
          resolve()
        }
      },
    }
    self.Module = Module // 非 modularize glue 读取全局 Module
    importScripts(runtimeBase + '/sherpa-onnx-wasm-main-asr.js')
    setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error('WASM 初始化超时（2 分钟）'))
      }
    }, 120000)
  })
  URL.revokeObjectURL(blobUrl)
  if (!self.SherpaOnnxASR) throw new Error('流式引擎 wrapper 未挂载')
  localMod = self.Module
  return localMod
}

async function transcribeLocal(pcm, runtimeBase, modelUrls) {
  const mod = await ensureLocalModule(runtimeBase, modelUrls)
  postStage('初始化 Zipformer 识别器…')
  const recognizer = self.SherpaOnnxASR.createOnlineRecognizer(mod)
  try {
    // 流式识别器处理整段音频：按 1s 喂入，收集 endpoint 定稿 + 尾部文本
    const stream = recognizer.createStream()
    try {
      const finals = []
      let lastPartial = ''
      const chunk = 16000 // 1s
      const totalChunks = Math.max(1, Math.ceil(pcm.length / chunk))
      let done = 0
      for (let off = 0; off < pcm.length; off += chunk) {
        const seg = pcm.subarray(off, Math.min(off + chunk, pcm.length))
        const f32 = new Float32Array(seg.length)
        for (let i = 0; i < seg.length; i++) f32[i] = seg[i] / 32768
        stream.acceptWaveform(16000, f32)
        while (recognizer.isReady(stream)) recognizer.decode(stream)
        const partial = fixLocalCase(recognizer.getResult(stream).text)
        if (partial) lastPartial = partial
        if (recognizer.isEndpoint(stream)) {
          if (partial) {
            finals.push(partial)
            lastPartial = ''
          }
          recognizer.reset(stream)
        }
        done++
        post({ type: 'progress', done, total: totalChunks })
      }
      const tail = fixLocalCase((recognizer.getResult(stream).text || '').trim())
      stream.inputFinished()
      post({ type: 'result', text: [...finals, tail, lastPartial].filter(Boolean).join('') })
    } finally {
      stream.free()
    }
  } finally {
    recognizer.free()
  }
}

// ---------- 消息入口（任务串行执行，避免识别器交叉使用） ----------

let chain = Promise.resolve()

async function handle(msg) {
  const pcm = new Int16Array(msg.pcm)
  if (msg.engine === 'offline') {
    await transcribeOffline(pcm, msg.language || '', msg.runtimeBase, msg.modelUrls)
  } else {
    await transcribeLocal(pcm, msg.runtimeBase, msg.modelUrls)
  }
}

self.onmessage = (e) => {
  const msg = e.data
  if (!msg || msg.type !== 'transcribe') return
  chain = chain
    .then(() => handle(msg))
    .catch((err) => post({ type: 'error', message: (err && err.message) || String(err) }))
}
