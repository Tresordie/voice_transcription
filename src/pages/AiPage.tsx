// AI 总结页：文本输入/附件（≤150MB）→ 大模型按模板/自定义提示词总结 → 美排结果 + 六格式导出 + 微信格式
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  Check,
  CircleAlert,
  Code2,
  Copy,
  FileDown,
  FileSpreadsheet,
  FileText,
  FileUp,
  History,
  Loader2,
  MessageCircle,
  Presentation,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { useSettings } from '../lib/store/settings'
import { useToast } from '../components/toast'
import MarkdownView from '../components/MarkdownView'
import { summarizeContent } from '../lib/ai/summarize'
import { extractFromFile, MAX_FILE_BYTES } from '../lib/ai/extract'
import { SCENARIOS, TEMPLATES, type SummaryTemplate } from '../lib/ai/templates'
import { exportSummary, markdownToWeChat, type ExportFormat } from '../lib/ai/exporters'
import { copyText, formatBytes } from '../lib/utils'
import { addHistoryItem, listHistory, newId, type HistoryItem } from '../lib/store/history'
import PageRecordsSection from '../components/pageRecords'

interface Attachment {
  id: string
  name: string
  size: number
  status: 'extracting' | 'done' | 'error'
  stage: string
  text: string
  error?: string
}

const EXPORTS: { fmt: ExportFormat; label: string; icon: typeof FileText }[] = [
  { fmt: 'md', label: 'Markdown', icon: FileText },
  { fmt: 'html', label: 'HTML', icon: Code2 },
  { fmt: 'pdf', label: 'PDF / 打印', icon: FileDown },
  { fmt: 'doc', label: 'Word', icon: FileText },
  { fmt: 'xlsx', label: 'Excel', icon: FileSpreadsheet },
  { fmt: 'pptx', label: 'PPT', icon: Presentation },
]

let attSeq = 0

function resultTitle(markdown: string): string {
  const h1 = markdown.match(/^#\s+(.+)$/m)?.[1]
  return (h1?.trim() || 'AI总结').replace(/[\\/:*?"<>|]/g, '').slice(0, 30)
}

export default function AiPage() {
  const { settings } = useSettings()
  const toast = useToast()

  const [inputText, setInputText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [scenario, setScenario] = useState<string>('all')
  const [template, setTemplate] = useState<SummaryTemplate | null>(null)
  const [userPrompt, setUserPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const [stage, setStage] = useState('')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState('')
  const [historyItems, setHistoryItems] = useState<HistoryItem[] | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const lastFlushRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const readyTexts = attachments.filter((a) => a.status === 'done' && a.text.trim())
  const failedAtts = attachments.filter((a) => a.status === 'error')
  const hasContent = inputText.trim().length > 0 || readyTexts.length > 0
  const aiConfigured = Boolean(settings.ai.baseURL && settings.ai.apiKey && settings.ai.model)

  const visibleTemplates = useMemo(
    () => (scenario === 'all' ? TEMPLATES : TEMPLATES.filter((t) => t.scenario === scenario)),
    [scenario],
  )

  // ---------- 附件 ----------
  const addFiles = useCallback(
    (list: FileList | File[]) => {
      for (const file of Array.from(list)) {
        const id = `att-${++attSeq}-${Date.now().toString(36)}`
        if (file.size > MAX_FILE_BYTES) {
          toast.show('error', `${file.name} 超过 150MB 上限`)
          continue
        }
        setAttachments((prev) => [
          ...prev,
          { id, name: file.name, size: file.size, status: 'extracting', stage: '准备提取…', text: '' },
        ])
        // 异步提取，逐个更新状态
        void extractFromFile(file, settings, (p) => {
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id ? { ...a, stage: p.stage, status: p.done !== undefined ? 'extracting' : a.status } : a,
            ),
          )
        })
          .then((text) => {
            setAttachments((prev) =>
              prev.map((a) => (a.id === id ? { ...a, status: 'done', stage: '提取完成', text } : a)),
            )
            toast.show('success', `${file.name} 内容提取完成`)
          })
          .catch((e: Error) => {
            if (e.name === 'AbortError') return
            setAttachments((prev) =>
              prev.map((a) => (a.id === id ? { ...a, status: 'error', error: e.message, stage: '提取失败' } : a)),
            )
          })
      }
    },
    [settings, toast],
  )

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  const openHistory = async () => {
    if (historyItems) {
      setHistoryItems(null)
      return
    }
    try {
      const items = (await listHistory()).filter((x) => x.source !== 'ai')
      setHistoryItems(items.slice(0, 30))
    } catch {
      toast.show('error', '历史记录读取失败')
    }
  }

  const importHistory = (item: HistoryItem) => {
    setInputText((prev) => (prev ? `${prev}\n\n${item.text}` : item.text))
    setHistoryItems(null)
    toast.show('success', '已导入历史转写内容')
  }

  // ---------- 生成 ----------
  const run = async () => {
    if (running) return
    if (!aiConfigured) {
      toast.show('error', '请先在「设置」页配置 AI 总结服务（Base URL / API Key / 模型）')
      return
    }
    const content = [inputText.trim(), ...readyTexts.map((a) => a.text.trim())].filter(Boolean).join('\n\n')
    if (!content) {
      toast.show('error', '请先输入内容或添加附件')
      return
    }
    setRunning(true)
    setResult('')
    setStage('连接模型…')
    setProgress(null)
    const ac = new AbortController()
    abortRef.current = ac
    try {
      const full = await summarizeContent(settings.ai, content, {
        template,
        userPrompt,
        signal: ac.signal,
        onProgress: (s, done, total) => {
          setStage(s)
          setProgress(total > 0 ? { done, total } : null)
        },
        onDelta: (_d, fullText) => {
          // 节流渲染：~150ms 刷一次，避免长文 markdown 全量重渲染过频
          const now = Date.now()
          if (now - lastFlushRef.current > 150) {
            lastFlushRef.current = now
            setResult(fullText)
          }
        },
      })
      setResult(full)
      // 生成完成即自动存入本页历史（参考 translate_tool：完成即记录，可在页面记录区随时载回）
      await addHistoryItem({
        id: newId(),
        createdAt: Date.now(),
        source: 'ai',
        engine: settings.ai.model,
        durationSec: 0,
        text: full,
      })
      toast.show('success', '总结完成，已存入本页历史')
    } catch (e) {
      const err = e as Error
      if (err.name !== 'AbortError') toast.show('error', err.message)
    } finally {
      abortRef.current = null
      setRunning(false)
      setProgress(null)
    }
  }

  const cancel = () => {
    abortRef.current?.abort()
    toast.show('info', '已取消')
  }

  const doExport = async (fmt: ExportFormat) => {
    if (!result.trim()) return
    try {
      await exportSummary(fmt, { title: resultTitle(result), markdown: result })
      toast.show('success', '已导出')
    } catch (e) {
      toast.show('error', `导出失败：${(e as Error).message}`)
    }
  }

  const copyWeChat = async () => {
    if (await copyText(markdownToWeChat(result))) toast.show('success', '微信格式已复制，可直接粘贴到微信')
    else toast.show('error', '复制失败')
  }

  // 从页面记录区载入一条历史到当前总结结果（有内容先确认替换）
  const loadFromHistory = (item: HistoryItem) => {
    if (running) {
      toast.show('error', '请等待当前总结完成再载入')
      return
    }
    if (result.trim() && !window.confirm('载入这条记录会替换当前总结结果，确定继续吗？')) return
    setResult(item.text)
    toast.show('success', '已载入历史记录')
  }

  // ---------- 渲染 ----------
  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">AI 总结</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          输入文本或上传附件，AI 先理解全文，再按预设模板 / 自定义提示词生成结构化总结
        </p>
      </header>

      {/* 输入区 */}
      <section className="card p-5">
        <h2 className="mb-3 font-semibold">1 · 输入内容</h2>
        <textarea
          className="input min-h-36 resize-y"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="粘贴要总结的文本内容（会议记录、文章、邮件线程、代码文档等）…"
          spellCheck={false}
        />
        <div
          className="mt-3 cursor-pointer rounded-xl border-2 border-dashed border-zinc-200 p-4 text-center transition-colors hover:border-indigo-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:border-indigo-600 dark:hover:bg-zinc-800/50"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
          }}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 mx-auto dark:bg-indigo-950/60">
            <FileUp className="h-5 w-5 text-indigo-500" />
          </div>
          <p className="mt-2 text-sm font-medium">拖拽附件到此处，或点击选择</p>
          <p className="mt-1 text-xs text-zinc-400">
            文档类（txt / md / csv / pdf / docx / xlsx / pptx）直接提取文本；音频（mp3 / wav / m4a
            等）自动转写后总结；单文件最大 150MB
          </p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </div>

        {/* 附件列表 */}
        {attachments.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {attachments.map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 px-3 py-2 dark:border-zinc-700"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{a.name}</p>
                  <p
                    className={`mt-0.5 text-xs ${
                      a.status === 'error'
                        ? 'text-red-500'
                        : a.status === 'done'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-zinc-500 dark:text-zinc-400'
                    }`}
                  >
                    {formatBytes(a.size)} · {a.stage}
                    {a.status === 'extracting' && progress && progress.total > 0 && a.stage.includes('转写') && `（${progress.done}/${progress.total}）`}
                  </p>
                  {a.status === 'error' && a.error && <p className="mt-0.5 text-xs text-red-500">{a.error}</p>}
                </div>
                {a.status === 'done' && <Check className="h-4 w-4 shrink-0 text-emerald-500" />}
                <button
                  className="btn-secondary !px-2 !py-1.5 shrink-0"
                  onClick={() => removeAttachment(a.id)}
                  title="移除"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className="btn-secondary !px-3" onClick={openHistory}>
            <History className="h-4 w-4" /> 从历史导入
          </button>
          {inputText.trim() && (
            <button className="btn-secondary !px-3" onClick={() => setInputText('')}>
              <Trash2 className="h-4 w-4" /> 清空文本
            </button>
          )}
        </div>

        {historyItems && (
          <div className="mt-3 max-h-56 overflow-y-auto rounded-xl border border-zinc-200 dark:border-zinc-700">
            {historyItems.length === 0 && <p className="p-4 text-sm text-zinc-400">暂无历史转写记录</p>}
            {historyItems.map((h) => (
              <button
                key={h.id}
                className="flex w-full items-center justify-between gap-3 border-b border-zinc-100 px-3 py-2 text-left text-sm last:border-0 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/60"
                onClick={() => importHistory(h)}
              >
                <span className="min-w-0 flex-1 truncate">
                  {h.text.slice(0, 60) || '（空）'}
                </span>
                <span className="shrink-0 text-xs text-zinc-400">{h.engine}</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 模板区 */}
      <section className="card p-5">
        <h2 className="mb-3 font-semibold">2 · 选择总结模板（可选）</h2>
        <div className="mb-3 flex flex-wrap gap-2">
          <button
            onClick={() => setScenario('all')}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              scenario === 'all'
                ? 'accent-gradient text-white shadow-sm'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
            }`}
          >
            全部（{TEMPLATES.length}）
          </button>
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              onClick={() => setScenario(s.id)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                scenario === s.id
                  ? 'accent-gradient text-white shadow-sm'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'
              }`}
            >
              {s.name}（{TEMPLATES.filter((t) => t.scenario === s.id).length}）
            </button>
          ))}
        </div>
        <div className="grid gap-2.5 sm:grid-cols-2">
          <button
            onClick={() => setTemplate(null)}
            className={`flex flex-col items-start gap-1 rounded-xl border-2 p-3 text-left transition-all ${
              template === null
                ? 'border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/40'
                : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-700 dark:hover:border-zinc-600'
            }`}
          >
            <span className="flex w-full items-center justify-between font-medium text-sm">
              自由总结（AI 自动组织结构）
              {template === null && <Check className="h-4 w-4 text-indigo-500" />}
            </span>
            <span className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              不套模板，AI 按内容自动生成结论先行、要点清晰的总结
            </span>
          </button>
          {visibleTemplates.map((t) => (
            <button
              key={t.id}
              onClick={() => setTemplate(t)}
              className={`flex flex-col items-start gap-1 rounded-xl border-2 p-3 text-left transition-all ${
                template?.id === t.id
                  ? 'border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/40'
                  : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-700 dark:hover:border-zinc-600'
              }`}
            >
              <span className="flex w-full items-center justify-between font-medium text-sm">
                <span className="min-w-0 truncate">
                  <span className="mr-1.5 font-mono text-xs text-indigo-500">{t.id}</span>
                  {t.name}
                </span>
                {template?.id === t.id && <Check className="h-4 w-4 shrink-0 text-indigo-500" />}
              </span>
              <span className="line-clamp-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{t.desc}</span>
            </button>
          ))}
        </div>
      </section>

      {/* 提示词 + 生成 */}
      <section className="card p-5">
        <h2 className="mb-3 font-semibold">3 · 补充要求（可选）</h2>
        <textarea
          className="input min-h-20 resize-y"
          value={userPrompt}
          onChange={(e) => setUserPrompt(e.target.value)}
          placeholder={
            template
              ? `已选模板「${template.name}」，可补充上下文或侧重方向（如：主题是XX、重点看成本部分）…`
              : '告诉 AI 侧重什么、输出多长、给谁看…（留空则自动总结）'
          }
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {running ? (
            <button className="btn-danger" onClick={cancel}>
              <X className="h-4 w-4" /> 取消
            </button>
          ) : (
            <button className="btn-primary !py-2.5 !px-6" onClick={run} disabled={!hasContent}>
              <Sparkles className="h-4.5 w-4.5" />
              {template ? `按「${template.name}」生成` : '开始总结'}
            </button>
          )}
          {running && (
            <span className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              {stage}
              {progress && progress.total > 0 && `（${progress.done}/${progress.total}）`}
            </span>
          )}
          {!aiConfigured && (
            <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
              <CircleAlert className="h-3.5 w-3.5" /> 未配置 AI 服务，请先到「设置」页完成配置
            </span>
          )}
        </div>
        {running && progress && progress.total > 0 && (
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div
              className="h-full rounded-full accent-gradient transition-all"
              style={{ width: `${Math.floor((progress.done / Math.max(1, progress.total)) * 100)}%` }}
            />
          </div>
        )}
        {failedAtts.length > 0 && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <CircleAlert className="h-3.5 w-3.5" />
            {failedAtts.length} 个附件提取失败，将不参与总结（详见上方列表）
          </p>
        )}
      </section>

      {/* 结果区 */}
      {(result || running) && (
        <section className="card p-5">
          <h2 className="mb-3 font-semibold">总结结果</h2>
          {result ? (
            <MarkdownView markdown={result} rich={!running} />
          ) : (
            <div className="flex items-center gap-2 py-8 text-sm text-zinc-400">
              <Loader2 className="h-5 w-5 animate-spin" /> {stage}
            </div>
          )}
          {result && (
            <>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  className="btn-secondary !px-3"
                  onClick={async () => {
                    if (await copyText(result)) toast.show('success', '全文已复制')
                  }}
                >
                  <Copy className="h-4 w-4" /> 复制全文
                </button>
                <button className="btn-secondary !px-3" onClick={copyWeChat}>
                  <MessageCircle className="h-4 w-4" /> 复制微信格式
                </button>
                {EXPORTS.map((x) => (
                  <button key={x.fmt} className="btn-secondary !px-3" onClick={() => void doExport(x.fmt)}>
                    <x.icon className="h-4 w-4" /> {x.label}
                  </button>
                ))}
              </div>
              <p className="mt-3 flex items-start gap-1.5 text-xs leading-5 text-zinc-400">
                「复制微信格式」生成适配微信聊天框的纯文本排版（emoji 标题 + 符号列表），粘贴后不乱格式
              </p>
            </>
          )}
        </section>
      )}

      {/* 页面记录：本页历史，点击行预览全文，可载入 / 下载 */}
      <PageRecordsSection source="ai" onLoad={loadFromHistory} filePrefix="AI总结" />
    </div>
  )
}
