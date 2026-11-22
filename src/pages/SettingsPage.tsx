// 设置页：引擎模式、识别语言、在线 API、本地模型管理、外观
import { useEffect, useState } from 'react'
import {
  Check,
  Cloud,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  MonitorSmartphone,
  Moon,
  ShieldCheck,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import { PROVIDERS, needsProxyHint, testOnline, withDevProxy, type ProviderId } from '../lib/asr/online'
import { chatLLM } from '../lib/ai/llm'
import {
  cancelLocalDownload,
  ensureLocalEngine,
  localEngineState,
  localModelCachedSize,
  removeLocalModel,
  useLocalEngineVersion,
} from '../lib/asr/local'
import {
  cancelOfflineDownload,
  ensureOfflineEngine,
  offlineEngineState,
  offlineModelCachedSize,
  removeOfflineModel,
  useOfflineEngineVersion,
} from '../lib/asr/offline'
import { SENSEVOICE_OFFLINE, ZIPFORMER_ZH_EN } from '../lib/models/catalog'
import { useSettings, type Language, type ThemeMode } from '../lib/store/settings'
import { useToast } from '../components/toast'
import { formatBytes } from '../lib/utils'

const LANGS: { id: Language; label: string }[] = [
  { id: 'auto', label: '自动' },
  { id: 'zh', label: '中文' },
  { id: 'en', label: '英文' },
]

const THEMES: { id: ThemeMode; label: string; icon: typeof Sun }[] = [
  { id: 'system', label: '跟随系统', icon: MonitorSmartphone },
  { id: 'light', label: '浅色', icon: Sun },
  { id: 'dark', label: '深色', icon: Moon },
]

/** 本地模型卡片：两个引擎（流式 zipformer / 离线 SenseVoice）共用一套状态结构 */
interface ModelCardProps {
  name: string
  desc: string
  sizeBytes: number
  state: { status: string; received: number; total: number; message: string }
  cachedBytes: number
  onDownload: () => void
  onCancel: () => void
  onDelete: () => void
}

function LocalModelCard({ name, desc, sizeBytes, state, cachedBytes, onDownload, onCancel, onDelete }: ModelCardProps) {
  const busy = state.status === 'downloading' || state.status === 'loading'
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-700">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">{name}</p>
          <p className="mt-0.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{desc}</p>
        </div>
        <span className="shrink-0 rounded-lg bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          {formatBytes(sizeBytes)}
        </span>
      </div>

      {busy && (
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
            <span>{state.message}</span>
            {state.status === 'downloading' && (
              <span>
                {formatBytes(state.received)} / {formatBytes(state.total)}
                {' '}({Math.floor((state.received / Math.max(1, state.total)) * 100)}%)
              </span>
            )}
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div
              className="h-full rounded-full accent-gradient transition-all"
              style={{
                width: state.status === 'loading' ? '100%' : `${Math.floor((state.received / Math.max(1, state.total)) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {state.status === 'ready' && (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
            <Check className="h-4 w-4" /> 已就绪{cachedBytes > 0 && ` · 缓存 ${formatBytes(cachedBytes)}`}
          </span>
        )}
        {state.status === 'error' && <span className="text-sm text-red-500">{state.message}</span>}
        {busy ? (
          state.status === 'downloading' && (
            <button className="btn-danger" onClick={onCancel}>
              <X className="h-4 w-4" /> 取消下载
            </button>
          )
        ) : (
          <>
            {state.status !== 'ready' && (
              <button className="btn-primary" onClick={onDownload}>
                下载模型
              </button>
            )}
            {cachedBytes > 0 && (
              <button className="btn-danger" onClick={onDelete}>
                <Trash2 className="h-4 w-4" /> 删除缓存
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default function SettingsPage() {
  const { settings, update, applyProvider } = useSettings()
  const toast = useToast()
  const localVer = useLocalEngineVersion()
  const offlineVer = useOfflineEngineVersion()

  const [showKey, setShowKey] = useState(false)
  const [showAiKey, setShowAiKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [aiTesting, setAiTesting] = useState(false)
  const [aiTestResult, setAiTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [cachedBytes, setCachedBytes] = useState(0)
  const [offlineBytes, setOfflineBytes] = useState(0)

  useEffect(() => {
    void localModelCachedSize().then(setCachedBytes)
  }, [localVer])
  useEffect(() => {
    void offlineModelCachedSize().then(setOfflineBytes)
  }, [offlineVer])

  const preset = PROVIDERS[settings.provider]

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    const r = await testOnline({
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      model: settings.model,
      language: settings.language,
      transport: settings.transport,
      hotwords: settings.hotwords,
    })
    setTestResult(r)
    setTesting(false)
  }

  const runAiTest = async () => {
    setAiTesting(true)
    setAiTestResult(null)
    try {
      const reply = await chatLLM(settings.ai, [{ role: 'user', content: '回复「OK」两个字母即可' }], {
        maxTokens: 16,
      })
      setAiTestResult({ ok: true, message: `连接成功：模型已应答「${reply.trim().slice(0, 20)}」` })
    } catch (e) {
      setAiTestResult({ ok: false, message: (e as Error).message })
    } finally {
      setAiTesting(false)
    }
  }

  const downloadModel = async () => {
    try {
      await ensureLocalEngine()
      toast.show('success', '本地模型已就绪')
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        toast.show('error', (e as Error).message)
      }
    }
  }

  const downloadOfflineModel = async () => {
    try {
      await ensureOfflineEngine()
      toast.show('success', '高精度离线模型已就绪')
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        toast.show('error', (e as Error).message)
      }
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">设置</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          选择识别引擎、配置在线服务或管理本地模型
        </p>
      </header>

      {/* 引擎模式 */}
      <section className="card p-5">
        <h2 className="mb-4 font-semibold">识别引擎</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <button
            onClick={() => update({ engineMode: 'local' })}
            className={`flex flex-col items-start gap-1.5 rounded-xl border-2 p-4 text-left transition-all ${
              settings.engineMode === 'local'
                ? 'border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/40'
                : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-700 dark:hover:border-zinc-600'
            }`}
          >
            <div className="flex w-full items-center justify-between">
              <span className="flex items-center gap-2 font-medium">
                <Cpu className="h-4.5 w-4.5 text-indigo-500" />
                本地模型
              </span>
              {settings.engineMode === 'local' && <Check className="h-4 w-4 text-indigo-500" />}
            </div>
            <span className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              浏览器内离线推理，数据不出设备、无网络也能用；首次需下载模型
            </span>
          </button>
          <button
            onClick={() => update({ engineMode: 'online' })}
            className={`flex flex-col items-start gap-1.5 rounded-xl border-2 p-4 text-left transition-all ${
              settings.engineMode === 'online'
                ? 'border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/40'
                : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-700 dark:hover:border-zinc-600'
            }`}
          >
            <div className="flex w-full items-center justify-between">
              <span className="flex items-center gap-2 font-medium">
                <Cloud className="h-4.5 w-4.5 text-indigo-500" />
                在线 API
              </span>
              {settings.engineMode === 'online' && <Check className="h-4 w-4 text-indigo-500" />}
            </div>
            <span className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              使用你自己的 API Key 调用云端大模型，准确率最高、无需下载
            </span>
          </button>
        </div>
      </section>

      {/* 识别语言 */}
      <section className="card p-5">
        <h2 className="mb-3 font-semibold">识别语言</h2>
        <div className="inline-flex rounded-xl border border-zinc-200 p-1 dark:border-zinc-700">
          {LANGS.map((l) => (
            <button
              key={l.id}
              onClick={() => update({ language: l.id })}
              className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
                settings.language === l.id
                  ? 'accent-gradient text-white shadow-sm'
                  : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-zinc-400">
          本地模型为中英混合识别，此设置主要影响在线引擎传入的 language 参数
        </p>
      </section>

      {/* 在线 API */}
      <section className="card p-5">
        <h2 className="mb-1 font-semibold">在线 API</h2>
        <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">{preset.note}</p>

        <div className="mb-4 flex flex-wrap gap-2">
          {(Object.keys(PROVIDERS) as ProviderId[]).map((id) => (
            <button
              key={id}
              onClick={() => applyProvider(id)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                settings.provider === id
                  ? 'accent-gradient text-white shadow-sm'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
              }`}
            >
              {PROVIDERS[id].label}
            </button>
          ))}
        </div>

        <div className="grid gap-4">
          <div>
            <label className="label">Base URL</label>
            <input
              className="input font-mono text-xs"
              value={settings.baseURL}
              onChange={(e) => update({ baseURL: e.target.value })}
              placeholder="https://api.example.com/v1"
            />
            {needsProxyHint(settings.baseURL) && (
              <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
                <span>⚠️ 阿里云域名未走代理，浏览器直连会被拦截</span>
                <button
                  type="button"
                  className="rounded-lg bg-amber-100 px-2 py-0.5 font-medium text-amber-700 transition-colors hover:bg-amber-200 dark:bg-amber-900/50 dark:text-amber-300 dark:hover:bg-amber-900"
                  onClick={() => update({ baseURL: withDevProxy(settings.baseURL) })}
                >
                  改用内置代理
                </button>
              </p>
            )}
          </div>
          <div>
            <label className="label">API Key</label>
            <div className="relative">
              <input
                className="input pr-10 font-mono text-xs"
                type={showKey ? 'text' : 'password'}
                value={settings.apiKey}
                onChange={(e) => update({ apiKey: e.target.value })}
                placeholder="sk-..."
                autoComplete="off"
              />
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                onClick={() => setShowKey((v) => !v)}
                type="button"
                title={showKey ? '隐藏' : '显示'}
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {preset.keyUrl && (
              <a
                href={preset.keyUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1.5 inline-flex items-center gap-1 text-xs text-indigo-500 hover:underline"
              >
                获取 {preset.label} API Key <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <div>
            <label className="label">模型</label>
            <input
              className="input font-mono text-xs"
              value={settings.model}
              onChange={(e) => update({ model: e.target.value })}
              placeholder="whisper-1"
            />
            {preset.models.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {preset.models.map((m) => (
                  <button
                    key={m}
                    onClick={() => update({ model: m })}
                    className={`rounded-lg px-2.5 py-1 font-mono text-xs transition-colors ${
                      settings.model === m
                        ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300'
                        : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="label">热词 / 上下文（可选）</label>
            <textarea
              className="input min-h-20 resize-y font-mono text-xs"
              value={settings.hotwords}
              onChange={(e) => update({ hotwords: e.target.value })}
              placeholder={'张伟、专有名词、品牌名\n或自由文本背景说明'}
              spellCheck={false}
            />
            <p className="mt-1.5 text-xs text-zinc-400">
              每行一个热词或自由文本，提高人名、品牌、领域词的识别准确率；百炼 Qwen-ASR 作为识别上下文，OpenAI 兼容服务作为 prompt 传入
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button className="btn-primary" onClick={runTest} disabled={testing}>
              {testing && <Loader2 className="h-4 w-4 animate-spin" />}
              测试连接
            </button>
            {testResult && (
              <span className={`text-xs ${testResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
                {testResult.message}
              </span>
            )}
          </div>
        </div>

        <p className="mt-4 flex items-start gap-1.5 rounded-xl bg-zinc-50 p-3 text-xs leading-5 text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
          API Key 仅保存在你的浏览器本地（localStorage），请求由浏览器直接发往服务商。
          本应用没有任何后端服务器，不经手你的密钥与音频数据。
        </p>
      </section>

      {/* AI 总结服务 */}
      <section className="card p-5">
        <h2 className="mb-1 font-semibold">AI 总结服务</h2>
        <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
          「AI 总结」页调用的大模型（OpenAI 兼容 chat/completions 协议），与语音识别引擎相互独立
        </p>

        <div className="grid gap-4">
          <div>
            <label className="label">Base URL</label>
            <input
              className="input font-mono text-xs"
              value={settings.ai.baseURL}
              onChange={(e) => update({ ai: { ...settings.ai, baseURL: e.target.value } })}
              placeholder="https://api.example.com/v1"
            />
            {needsProxyHint(settings.ai.baseURL) && (
              <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
                <span>⚠️ 阿里云域名未走代理，浏览器直连会被拦截</span>
                <button
                  type="button"
                  className="rounded-lg bg-amber-100 px-2 py-0.5 font-medium text-amber-700 transition-colors hover:bg-amber-200 dark:bg-amber-900/50 dark:text-amber-300 dark:hover:bg-amber-900"
                  onClick={() => update({ ai: { ...settings.ai, baseURL: withDevProxy(settings.ai.baseURL) } })}
                >
                  改用内置代理
                </button>
              </p>
            )}
            <p className="mt-1.5 text-xs text-zinc-400">
              例：硅基流动 https://api.siliconflow.cn/v1（免费额度）· 阿里百炼
              https://dashscope.aliyuncs.com/compatible-mode/v1 · 阿里 Token Plan
              https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1（需 sk-sp- 专属 Key，且必须走代理）
            </p>
          </div>
          <div>
            <label className="label">API Key</label>
            <div className="relative">
              <input
                className="input pr-10 font-mono text-xs"
                type={showAiKey ? 'text' : 'password'}
                value={settings.ai.apiKey}
                onChange={(e) => update({ ai: { ...settings.ai, apiKey: e.target.value } })}
                placeholder="sk-..."
                autoComplete="off"
              />
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                onClick={() => setShowAiKey((v) => !v)}
                type="button"
                title={showAiKey ? '隐藏' : '显示'}
              >
                {showAiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div>
            <label className="label">模型</label>
            <input
              className="input font-mono text-xs"
              value={settings.ai.model}
              onChange={(e) => update({ ai: { ...settings.ai, model: e.target.value } })}
              placeholder="如 qwen3-max / deepseek-chat / glm-4-plus"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {['qwen3-max', 'qwen-plus', 'deepseek-chat', 'glm-4-plus'].map((m) => (
                <button
                  key={m}
                  onClick={() => update({ ai: { ...settings.ai, model: m } })}
                  className={`rounded-lg px-2.5 py-1 font-mono text-xs transition-colors ${
                    settings.ai.model === m
                      ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300'
                      : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button className="btn-primary" onClick={runAiTest} disabled={aiTesting}>
              {aiTesting && <Loader2 className="h-4 w-4 animate-spin" />}
              测试连接
            </button>
            {aiTestResult && (
              <span className={`text-xs ${aiTestResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
                {aiTestResult.message}
              </span>
            )}
          </div>
        </div>
      </section>

      {/* 本地模型 */}
      <section className="card p-5">
        <h2 className="mb-1 font-semibold">本地模型</h2>
        <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
          实时转录使用流式模型；文件转写在 SenseVoice 已下载时自动切换到高精度引擎；下载后缓存，离线可用
        </p>

        <div className="flex flex-col gap-4">
          <LocalModelCard
            name={ZIPFORMER_ZH_EN.name}
            desc={ZIPFORMER_ZH_EN.desc}
            sizeBytes={ZIPFORMER_ZH_EN.dataBytes}
            state={localEngineState}
            cachedBytes={cachedBytes}
            onDownload={downloadModel}
            onCancel={cancelLocalDownload}
            onDelete={async () => {
              await removeLocalModel()
              setCachedBytes(0)
              toast.show('info', '模型缓存已删除')
            }}
          />
          <LocalModelCard
            name={SENSEVOICE_OFFLINE.name}
            desc={SENSEVOICE_OFFLINE.desc}
            sizeBytes={SENSEVOICE_OFFLINE.dataBytes}
            state={offlineEngineState}
            cachedBytes={offlineBytes}
            onDownload={downloadOfflineModel}
            onCancel={cancelOfflineDownload}
            onDelete={async () => {
              await removeOfflineModel()
              setOfflineBytes(0)
              toast.show('info', '模型缓存已删除')
            }}
          />
        </div>

        <p className="mt-3 text-xs text-zinc-400">
          模型为官方 sherpa-onnx WASM 构建（流式 zipformer 中英双语 int8 / 非流式 SenseVoice 多语种 int8），
          从 HuggingFace 镜像下载，仅缓存在你的浏览器中。
        </p>
      </section>

      {/* 外观 */}
      <section className="card p-5">
        <h2 className="mb-3 font-semibold">外观</h2>
        <div className="flex flex-wrap gap-2">
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => update({ theme: t.id })}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                settings.theme === t.id
                  ? 'accent-gradient text-white shadow-sm'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
              }`}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
