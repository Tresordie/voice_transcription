// 文件转写页：拖拽上传音频 → 本地推理 / 在线 API 分段转写
import { useCallback, useRef, useState } from 'react'
import {
  AudioLines,
  Copy,
  Download,
  FileAudio2,
  Save,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { decodeToPcm16k } from '../lib/audio/wav'
import {
  ensureLocalEngine,
  localEngineState,
  transcribePcmLocal,
  useLocalEngineVersion,
} from '../lib/asr/local'
import { offlineModelCached, transcribePcmOffline, useOfflineEngineVersion } from '../lib/asr/offline'
import { transcribeFile, type OnlineConfig } from '../lib/asr/online'
import { useSettings } from '../lib/store/settings'
import { addHistoryItem, newId, type HistoryItem } from '../lib/store/history'
import { useToast } from '../components/toast'
import PageRecordsSection from '../components/pageRecords'
import {
  copyText,
  downloadText,
  formatBytes,
  timestampName,
} from '../lib/utils'

export default function FilePage() {
  const { settings } = useSettings()
  const toast = useToast()
  useLocalEngineVersion()
  useOfflineEngineVersion()

  const [file, setFile] = useState<File | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [working, setWorking] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState('')

  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const isLocal = settings.engineMode === 'local'
  const hasResult = result.length > 0

  const pickFile = useCallback(
    (f: File | null | undefined) => {
      if (!f) return
      if (!f.type.startsWith('audio/') && !/\.(wav|mp3|m4a|aac|ogg|opus|webm|flac)$/i.test(f.name)) {
        toast.show('error', '请选择音频文件（wav / mp3 / m4a / ogg / webm 等）')
        return
      }
      setFile(f)
      setResult('')
      setDuration(null)
      // 读取时长用于展示
      const url = URL.createObjectURL(f)
      const audio = new Audio()
      audio.preload = 'metadata'
      audio.onloadedmetadata = () => {
        setDuration(Number.isFinite(audio.duration) ? audio.duration : null)
        URL.revokeObjectURL(url)
      }
      audio.src = url
    },
    [toast],
  )

  const onlineCfg = useCallback(
    (): OnlineConfig => ({
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      model: settings.model,
      language: settings.language,
      transport: settings.transport,
      hotwords: settings.hotwords,
    }),
    [settings],
  )

  const start = async () => {
    if (!file || working) return
    setWorking(true)
    setResult('')
    setStatusMsg('')
    setProgress(null)
    try {
      let text: string
      if (isLocal) {
        setStatusMsg('解码音频…')
        const { pcm } = await decodeToPcm16k(file)
        if (await offlineModelCached()) {
          // SenseVoice 非流式引擎（高精度、自动标点），模型已缓存时优先使用
          setStatusMsg('本地识别中（SenseVoice 高精度）…')
          text = await transcribePcmOffline(
            pcm,
            settings.language === 'auto' ? '' : settings.language,
            { onProgress: (done, total) => setProgress({ done, total }) },
          )
        } else {
          const module = await ensureLocalEngine()
          setStatusMsg('本地识别中（快于实时速度）…')
          text = await transcribePcmLocal(module, pcm)
        }
      } else {
        if (!settings.apiKey) {
          throw new Error('尚未配置在线 API Key，请前往「设置」页填写，或切换到本地模型')
        }
        const ac = new AbortController()
        abortRef.current = ac
        setStatusMsg('上传转写中…')
        text = await transcribeFile(file, onlineCfg(), {
          signal: ac.signal,
          onProgress: (done, total) => setProgress({ done, total }),
        })
      }
      setResult(text)
      if (!text.trim()) {
        toast.show('info', '转写完成，但未识别到语音内容')
      }
    } catch (e) {
      const err = e as Error
      if (err.name !== 'AbortError') toast.show('error', err.message)
    } finally {
      abortRef.current = null
      setWorking(false)
      setProgress(null)
      setStatusMsg('')
    }
  }

  const cancel = () => {
    abortRef.current?.abort()
    toast.show('info', '已取消')
  }

  const saveToHistory = async () => {
    if (!result.trim()) return
    await addHistoryItem({
      id: newId(),
      createdAt: Date.now(),
      source: 'file',
      engine: isLocal ? '本地模型' : `在线 · ${settings.model}`,
      durationSec: duration ?? 0,
      text: result,
    })
    toast.show('success', '已存入历史记录')
  }

  // 从页面记录区载入一条历史到当前转写结果（有内容先确认替换）
  const loadFromHistory = (item: HistoryItem) => {
    if (working) {
      toast.show('error', '请等待当前转写完成再载入')
      return
    }
    if (result.trim() && !window.confirm('载入这条记录会替换当前转写结果，确定继续吗？')) return
    setResult(item.text)
    toast.show('success', '已载入历史记录')
  }

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">文件转写</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          上传录音文件，离线或在线引擎转写为文字
        </p>
      </header>

      {/* 上传区 */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          pickFile(e.dataTransfer.files?.[0])
        }}
        onClick={() => !working && inputRef.current?.click()}
        className={`card flex cursor-pointer flex-col items-center gap-3 border-2 border-dashed px-6 py-12 text-center transition-colors ${
          dragging
            ? 'border-indigo-400 bg-indigo-50/50 dark:bg-indigo-950/30'
            : 'border-zinc-200 hover:border-indigo-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:border-indigo-600 dark:hover:bg-zinc-800/50'
        }`}
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-50 dark:bg-indigo-950/60">
          <Upload className="h-6 w-6 text-indigo-500" />
        </div>
        <div>
          <p className="font-medium">拖拽音频文件到此处，或点击选择</p>
          <p className="mt-1 text-xs text-zinc-400">支持 wav / mp3 / m4a / aac / ogg / opus / webm / flac</p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.opus,.webm,.flac"
          className="hidden"
          onChange={(e) => pickFile(e.target.files?.[0])}
        />
      </div>

      {/* 已选文件 */}
      {file && (
        <div className="card flex items-center gap-3 p-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-100 dark:bg-zinc-800">
            <FileAudio2 className="h-5 w-5 text-zinc-500" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{file.name}</p>
            <p className="text-xs text-zinc-400">
              {formatBytes(file.size)}
              {duration !== null && ` · ${Math.floor(duration / 60)}分${Math.round(duration % 60)}秒`}
            </p>
          </div>
          {!working && (
            <button
              className="btn-secondary !px-3"
              onClick={() => {
                setFile(null)
                setResult('')
              }}
              title="移除文件"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {/* 开始/进度 */}
      {file && !hasResult && (
        <div className="flex flex-col items-stretch gap-3">
          {working ? (
            <div className="card flex flex-col gap-2 p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 animate-pulse text-indigo-500" />
                  {statusMsg || '处理中…'}
                </span>
                {progress && (
                  <span className="text-zinc-500 dark:text-zinc-400">
                    {progress.done} / {progress.total} 段
                  </span>
                )}
              </div>
              {(progress || statusMsg.includes('本地')) && (
                <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div
                    className="h-full rounded-full accent-gradient transition-all"
                    style={{
                      width: progress
                        ? `${Math.floor((progress.done / Math.max(1, progress.total)) * 100)}%`
                        : '40%',
                    }}
                  />
                </div>
              )}
              {!isLocal && (
                <button className="btn-danger self-start" onClick={cancel}>
                  取消
                </button>
              )}
            </div>
          ) : (
            <button className="btn-primary !py-3 text-base" onClick={start}>
              <Sparkles className="h-5 w-5" />
              开始转写（{isLocal ? '本地模型' : `在线 · ${settings.model}`}）
            </button>
          )}
        </div>
      )}

      {/* 结果 */}
      {hasResult && (
        <>
          <div className="card p-5">
            <textarea
              value={result}
              onChange={(e) => setResult(e.target.value)}
              rows={10}
              className="w-full resize-y bg-transparent text-[15px] leading-7 focus:outline-none"
              placeholder="转写结果"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-secondary"
              onClick={async () => {
                if (await copyText(result)) toast.show('success', '已复制到剪贴板')
              }}
            >
              <Copy className="h-4 w-4" /> 复制
            </button>
            <button
              className="btn-secondary"
              onClick={() => downloadText(result, timestampName('转写', 'txt'))}
            >
              <Download className="h-4 w-4" /> 导出 TXT
            </button>
            <button className="btn-secondary" onClick={saveToHistory}>
              <Save className="h-4 w-4" /> 存入历史
            </button>
            <button
              className="btn-danger"
              onClick={() => {
                setResult('')
                setFile(null)
              }}
            >
              <Trash2 className="h-4 w-4" /> 清空
            </button>
          </div>
        </>
      )}

      {/* 引擎提示 */}
      <p className="flex items-center gap-1.5 text-xs text-zinc-400">
        <AudioLines className="h-3.5 w-3.5" />
        当前引擎：{isLocal ? '本地模型（离线可用）' : `在线 API · ${settings.model}`}
        {isLocal && localEngineState.status === 'no-model' && '（首次使用需下载模型，约 190MB）'}
      </p>

      {/* 页面记录：本页历史，点击行预览全文，可载入 / 下载 */}
      <PageRecordsSection source="file" onLoad={loadFromHistory} filePrefix="转写" />
    </div>
  )
}
