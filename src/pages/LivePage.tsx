// 实时转录页：麦克风采集 → 本地流式识别 / 在线分段识别
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AudioLines,
  Copy,
  Download,
  Mic,
  Save,
  Square,
  Trash2,
} from 'lucide-react'
import { MicRecorder } from '../lib/audio/capture'
import { LiveSegmenter } from '../lib/audio/segmenter'
import {
  ensureLocalEngine,
  localEngineState,
  LocalStreamSession,
  useLocalEngineVersion,
} from '../lib/asr/local'
import { joinParts, transcribeBlob, type OnlineConfig } from '../lib/asr/online'
import { useSettings } from '../lib/store/settings'
import { addHistoryItem, newId } from '../lib/store/history'
import { useToast } from '../components/toast'
import { Waveform } from '../components/Waveform'
import {
  copyText,
  downloadText,
  formatBytes,
  formatDuration,
  timestampName,
} from '../lib/utils'

export default function LivePage() {
  const { settings } = useSettings()
  const toast = useToast()
  useLocalEngineVersion() // 本地引擎状态变化触发重渲染

  const [phase, setPhase] = useState<'idle' | 'preparing' | 'recording'>('idle')
  const [finals, setFinals] = useState<string[]>([])
  const [partial, setPartial] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [levels, setLevels] = useState<number[]>([])
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null)

  const recorderRef = useRef<MicRecorder | null>(null)
  const sessionRef = useRef<LocalStreamSession | null>(null)
  const segmenterRef = useRef<LiveSegmenter | null>(null)
  const finalsRef = useRef<string[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const levelTsRef = useRef(0)
  const liveRef = useRef(false) // 卸载时是否需要清理录音

  const fullText = joinParts(finals)
  const isLocal = settings.engineMode === 'local'

  const onlineCfg = useCallback(
    (): OnlineConfig => ({
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      model: settings.model,
      language: settings.language,
      transport: settings.transport,
    }),
    [settings],
  )

  const pushFinal = useCallback((t: string) => {
    if (!t) return
    finalsRef.current.push(t)
    setFinals([...finalsRef.current])
    setPartial('')
  }, [])

  const onLevel = useCallback((rms: number) => {
    const now = performance.now()
    if (now - levelTsRef.current < 50) return
    levelTsRef.current = now
    setLevels((prev) => [...prev.slice(-95), rms])
  }, [])

  const cleanupTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  const start = async () => {
    if (phase !== 'idle') return
    setPhase('preparing')
    finalsRef.current = []
    setFinals([])
    setPartial('')
    setElapsed(0)
    setRecordingBlob(null)
    try {
      const recorder = new MicRecorder()
      if (isLocal) {
        // 首次使用会自动下载模型（进度显示在状态卡中）
        const module = await ensureLocalEngine()
        const session = new LocalStreamSession(module)
        session.onFinal = pushFinal
        session.onPartial = setPartial
        sessionRef.current = session
        await recorder.start({
          onLevel,
          onPcm16: (pcm) => sessionRef.current?.feed(pcm),
        })
      } else {
        const seg = new LiveSegmenter(16000, 4000)
        seg.onSegment = (wav, seq) => {
          transcribeBlob(wav, `live-${seq}.wav`, onlineCfg())
            .then(pushFinal)
            .catch((e) => toast.show('error', `分段识别失败：${(e as Error).message}`))
        }
        segmenterRef.current = seg
        await recorder.start({
          onLevel,
          onPcm16: (pcm) => segmenterRef.current?.push(pcm),
        })
      }
      recorderRef.current = recorder
      liveRef.current = true
      const t0 = Date.now()
      timerRef.current = setInterval(
        () => setElapsed(Math.floor((Date.now() - t0) / 1000)),
        250,
      )
      setPhase('recording')
    } catch (e) {
      const err = e as Error
      const hint = err.name === 'NotAllowedError'
        ? '麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问后重试'
        : err.message
      toast.show('error', hint)
      setPhase('idle')
    }
  }

  const stop = async () => {
    cleanupTimer()
    try {
      if (isLocal) {
        const tail = sessionRef.current?.finish() ?? ''
        if (tail.trim()) pushFinal(tail.trim())
        setPartial('')
        sessionRef.current?.dispose()
        sessionRef.current = null
      } else {
        const rest = segmenterRef.current?.flush()
        segmenterRef.current = null
        if (rest) {
          try {
            const t = await transcribeBlob(rest, 'live-final.wav', onlineCfg())
            pushFinal(t)
          } catch {
            // 尾段失败不提示，主内容已保留
          }
        }
        setPartial('')
      }
      const blob = recorderRef.current ? await recorderRef.current.stop() : null
      recorderRef.current = null
      liveRef.current = false
      setRecordingBlob(blob)
      setLevels([])
      setPhase('idle')
    } catch (e) {
      toast.show('error', (e as Error).message)
      setPhase('idle')
    }
  }

  // 卸载清理
  useEffect(() => {
    return () => {
      cleanupTimer()
      if (liveRef.current) {
        void recorderRef.current?.stop().catch(() => undefined)
        sessionRef.current?.dispose()
      }
    }
  }, [])

  const saveToHistory = async () => {
    if (!fullText.trim()) return
    await addHistoryItem({
      id: newId(),
      createdAt: Date.now(),
      source: 'live',
      engine: isLocal ? '本地模型' : `在线 · ${settings.model}`,
      durationSec: elapsed,
      text: fullText,
    })
    toast.show('success', '已存入历史记录')
  }

  const copyAll = async () => {
    if (await copyText(fullText)) toast.show('success', '已复制到剪贴板')
    else toast.show('error', '复制失败，请手动选择文本复制')
  }

  const engineLabel = isLocal ? '本地模型' : `在线 · ${settings.model}`

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">实时转录</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          点击麦克风开始，说话内容将实时转为文字
        </p>
      </header>

      {/* 引擎状态条 */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-3 py-1 font-medium text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400">
          <AudioLines className="h-3.5 w-3.5" />
          {engineLabel}
        </span>
        <span className="rounded-full bg-zinc-100 px-3 py-1 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          语言：{settings.language === 'auto' ? '自动' : settings.language === 'zh' ? '中文' : '英文'}
        </span>
        {phase === 'recording' && (
          <span className="rounded-full bg-red-50 px-3 py-1 font-medium text-red-600 dark:bg-red-950/60 dark:text-red-400">
            ● 录制中 {formatDuration(elapsed)}
          </span>
        )}
      </div>

      {/* 本地模型进度卡（下载/加载时显示） */}
      {isLocal && (localEngineState.status === 'downloading' || localEngineState.status === 'loading') && (
        <div className="card p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span>{localEngineState.message || '准备中…'}</span>
            {localEngineState.status === 'downloading' && (
              <span className="text-zinc-500 dark:text-zinc-400">
                {formatBytes(localEngineState.received)} / {formatBytes(localEngineState.total)}
                {' '}({Math.floor((localEngineState.received / Math.max(1, localEngineState.total)) * 100)}%)
              </span>
            )}
          </div>
          {localEngineState.status === 'downloading' && (
            <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              <div
                className="h-full rounded-full accent-gradient transition-all"
                style={{
                  width: `${Math.floor((localEngineState.received / Math.max(1, localEngineState.total)) * 100)}%`,
                }}
              />
            </div>
          )}
          <p className="mt-2 text-xs text-zinc-400">
            模型下载一次后自动缓存，之后离线可用
          </p>
        </div>
      )}

      {/* 麦克风 + 波形 */}
      <div className="card flex flex-col items-center gap-6 px-6 py-10">
        <button
          onClick={phase === 'idle' ? start : stop}
          disabled={phase === 'preparing'}
          className={`relative flex h-24 w-24 items-center justify-center rounded-full text-white shadow-lg transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-60 ${
            phase === 'recording'
              ? 'bg-gradient-to-br from-red-500 to-rose-600'
              : 'accent-gradient hover:brightness-110'
          }`}
          title={phase === 'idle' ? '开始录音' : '停止录音'}
        >
          {phase === 'recording' && (
            <span className="animate-pulse-ring absolute inset-0 rounded-full bg-red-500/40" />
          )}
          {phase === 'recording' ? (
            <Square className="h-8 w-8" />
          ) : (
            <Mic className="h-9 w-9" />
          )}
        </button>
        <div className="text-center">
          {phase === 'preparing' ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">准备中：{localEngineState.message || '正在启动…'}</p>
          ) : phase === 'recording' ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">正在聆听，点击停止结束</p>
          ) : (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {fullText ? '录音完成，可继续新的录音' : '点击开始实时转写'}
            </p>
          )}
        </div>
        <Waveform levels={levels} active={phase === 'recording'} />
      </div>

      {/* 转录结果 */}
      <div className="card p-5">
        {fullText || partial ? (
          <div className="max-h-72 overflow-y-auto whitespace-pre-wrap break-all text-[15px] leading-7">
            {fullText}
            {partial && (
              <span className="text-zinc-400 dark:text-zinc-500">{partial}</span>
            )}
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-zinc-400">
            转录内容将显示在这里
          </p>
        )}
      </div>

      {/* 工具栏 */}
      {fullText && (
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" onClick={copyAll}>
            <Copy className="h-4 w-4" /> 复制全文
          </button>
          <button
            className="btn-secondary"
            onClick={() => downloadText(fullText, timestampName('转录', 'txt'))}
          >
            <Download className="h-4 w-4" /> 导出 TXT
          </button>
          <button className="btn-secondary" onClick={saveToHistory}>
            <Save className="h-4 w-4" /> 存入历史
          </button>
          {recordingBlob && (
            <a
              className="btn-secondary"
              href={URL.createObjectURL(recordingBlob)}
              download={timestampName('录音', 'webm')}
            >
              <Download className="h-4 w-4" /> 下载录音
            </a>
          )}
          <button
            className="btn-danger"
            onClick={() => {
              finalsRef.current = []
              setFinals([])
              setPartial('')
              setRecordingBlob(null)
            }}
          >
            <Trash2 className="h-4 w-4" /> 清空
          </button>
        </div>
      )}
    </div>
  )
}
