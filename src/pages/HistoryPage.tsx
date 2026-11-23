// 历史记录页：转录结果列表、查看、复制、删除、全量导出/导入
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AudioLines,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileAudio2,
  History,
  Trash2,
  Upload,
} from 'lucide-react'
import {
  clearHistory,
  deleteHistoryItem,
  importHistoryItems,
  listHistory,
  type HistoryItem,
} from '../lib/store/history'
import { useToast } from '../components/toast'
import { copyText, downloadText, formatDate, formatDuration, timestampName } from '../lib/utils'

// —— git 备份服务（vite dev 内置 /backup-api）相关类型 ——
interface BackupPushed {
  url: string
  ok: boolean
  detail?: string
}
interface BackupStatus {
  connected: boolean
  repoPath: string
  fileExists?: boolean
  fileMtime?: string | null
  lastCommit?: { hash: string; date: string; message: string } | null
}
interface BackupOpResult {
  ok: boolean
  committed?: boolean
  pushed?: BackupPushed[]
  error?: string
}

const remoteName = (url: string) =>
  url.includes('github') ? 'GitHub' : url.includes('gitee') ? 'Gitee' : url

export default function HistoryPage({ active = true }: { active?: boolean }) {
  const toast = useToast()
  const [items, setItems] = useState<HistoryItem[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null)
  const [backupResult, setBackupResult] = useState<BackupOpResult | null>(null)
  const [backupBusy, setBackupBusy] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await listHistory())
    } finally {
      setLoading(false)
    }
  }, [])

  // 备份服务状态（仅本机 dev 服务器提供；接口不存在时保持未连接态）
  const loadBackupStatus = useCallback(async () => {
    try {
      const r = await fetch('/backup-api/status')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setBackupStatus(await r.json())
    } catch {
      setBackupStatus({ connected: false, repoPath: '' })
    }
  }, [])

  // 页面保持挂载：每次切回本页时刷新列表（捕获其他页面新存入的记录）
  useEffect(() => {
    if (active) {
      void refresh()
      void loadBackupStatus()
    }
  }, [active, refresh, loadBackupStatus])

  const toggle = (id: string) => {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const remove = async (id: string) => {
    await deleteHistoryItem(id)
    setItems((xs) => xs.filter((x) => x.id !== id))
    toast.show('info', '已删除')
  }

  const removeAll = async () => {
    if (items.length === 0) return
    if (!window.confirm(`确定清空全部 ${items.length} 条历史记录吗？`)) return
    await clearHistory()
    setItems([])
    toast.show('info', '历史已清空')
  }

  // 全量导出 JSON（含 source/engine/时长等元数据）
  // 备份服务可用时：直接写入备份仓库 data/history.json 并 commit + push（自动双推）；
  // 不可用时退回浏览器下载，由用户手动放入备份仓库。
  const exportAll = async () => {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: items.length,
      items,
    }
    const text = JSON.stringify(payload, null, 2)
    setBackupBusy(true)
    try {
      const r = await fetch('/backup-api/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: text,
      })
      const data: BackupOpResult = await r.json()
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setBackupResult(data)
      void loadBackupStatus()
      const pushed = data.pushed ?? []
      const allOk = pushed.length > 0 && pushed.every((p) => p.ok)
      const names = pushed.map((p) => `${remoteName(p.url)}${p.ok ? ' ✓' : ' ✗'}`).join(' · ')
      toast.show(
        allOk ? 'success' : 'error',
        data.committed ? `已备份并推送（${names}）` : `内容无变化，已同步（${names}）`,
      )
    } catch {
      downloadText(text, timestampName('历史备份', 'json'))
      toast.show('info', '备份服务未连接，已改为浏览器下载')
    } finally {
      setBackupBusy(false)
    }
  }

  // 手动推送：把备份仓库里的 data/history.json 提交（如有变化）并推送到全部远端
  const pushBackup = async () => {
    setBackupBusy(true)
    try {
      const r = await fetch('/backup-api/push', { method: 'POST' })
      const data: BackupOpResult = await r.json()
      setBackupResult(data)
      void loadBackupStatus()
      if (r.ok && data.ok) {
        const pushed = data.pushed ?? []
        const allOk = pushed.length > 0 && pushed.every((p) => p.ok)
        const names = pushed.map((p) => `${remoteName(p.url)}${p.ok ? ' ✓' : ' ✗'}`).join(' · ')
        toast.show(allOk ? 'success' : 'error', names ? `推送完成（${names}）` : '未找到推送地址')
      } else {
        toast.show('error', data.error || '推送失败')
      }
    } catch {
      toast.show('error', '备份服务未连接')
    } finally {
      setBackupBusy(false)
    }
  }

  // 导入 JSON 备份：按 id 合并去重，不覆盖已有记录
  const importAll = async (file: File) => {
    try {
      const data = JSON.parse(await file.text())
      const arr = Array.isArray(data) ? data : data?.items
      if (!Array.isArray(arr)) throw new Error('bad format')
      const { added, skipped } = await importHistoryItems(arr)
      await refresh()
      toast.show('success', `导入 ${added} 条${skipped > 0 ? `，跳过 ${skipped} 条` : ''}`)
    } catch {
      toast.show('error', '文件格式不正确')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">历史记录</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            保存的转录结果仅存于你的浏览器中，支持导出 JSON 备份与导入恢复
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button className="btn-secondary" onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-4 w-4" /> 导入
          </button>
          {items.length > 0 && (
            <>
              <button className="btn-secondary" onClick={() => void exportAll()}>
                <Download className="h-4 w-4" />
                {backupStatus?.connected ? '备份并推送' : '导出全部'}
              </button>
              <button className="btn-danger" onClick={removeAll}>
                <Trash2 className="h-4 w-4" /> 清空
              </button>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importAll(f)
            }}
          />
        </div>
      </header>

      <div className="card flex flex-col gap-1.5 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">git 备份</p>
          <button
            className="btn-secondary !px-3 !py-1.5 text-xs"
            disabled={!backupStatus?.connected || backupBusy}
            onClick={() => void pushBackup()}
          >
            推送
          </button>
        </div>
        {backupStatus?.connected ? (
          <div className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            <p className="break-all">仓库：{backupStatus.repoPath}</p>
            <p className="break-all">
              data/history.json：
              {backupStatus.fileExists && backupStatus.fileMtime
                ? `更新于 ${formatDate(new Date(backupStatus.fileMtime).getTime())}`
                : '尚未生成（首次备份后自动写入）'}
              {backupStatus.lastCommit &&
                ` · 最近提交 ${backupStatus.lastCommit.hash} ${backupStatus.lastCommit.message}`}
            </p>
            {backupResult?.pushed && backupResult.pushed.length > 0 && (
              <p>
                最近推送：
                {backupResult.pushed.map((p) => `${remoteName(p.url)} ${p.ok ? '✓' : '✗'}`).join(' · ')}
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs leading-5 text-zinc-400 dark:text-zinc-500">
            本地备份服务未连接（需以 npm run dev 启动应用）。「导出全部」将退回浏览器下载，
            可手动放入备份仓库 data/ 目录后点「推送」。
          </p>
        )}
      </div>

      {loading ? (
        <p className="py-10 text-center text-sm text-zinc-400">加载中…</p>
      ) : items.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 px-6 py-16 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100 dark:bg-zinc-800">
            <History className="h-6 w-6 text-zinc-400" />
          </div>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            还没有历史记录
          </p>
          <p className="text-xs text-zinc-400">
            在「实时转录」或「文件转写」页完成后点击「存入历史」
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => {
            const open = expanded.has(item.id)
            return (
              <div key={item.id} className="card overflow-hidden">
                <button
                  className="flex w-full items-center gap-3 p-4 text-left"
                  onClick={() => toggle(item.id)}
                >
                  {open ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />
                  )}
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 dark:bg-indigo-950/60">
                    {item.source === 'live' ? (
                      <AudioLines className="h-4.5 w-4.5 text-indigo-500" />
                    ) : (
                      <FileAudio2 className="h-4.5 w-4.5 text-indigo-500" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {item.text.slice(0, 60) || '（空）'}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-400">
                      {item.source === 'live' ? '实时转录' : '文件转写'}
                      {' · '}
                      {item.engine}
                      {item.durationSec > 0 && ` · ${formatDuration(item.durationSec)}`}
                      {' · '}
                      {formatDate(item.createdAt)}
                    </p>
                  </div>
                </button>
                {open && (
                  <div className="border-t border-zinc-100 px-4 pb-4 pt-3 dark:border-zinc-800">
                    <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all text-sm leading-6">
                      {item.text}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        className="btn-secondary !px-3 !py-1.5 text-xs"
                        onClick={async () => {
                          if (await copyText(item.text)) toast.show('success', '已复制')
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" /> 复制
                      </button>
                      <button
                        className="btn-secondary !px-3 !py-1.5 text-xs"
                        onClick={() =>
                          downloadText(item.text, timestampName('转录', 'txt'))
                        }
                      >
                        <Download className="h-3.5 w-3.5" /> 导出
                      </button>
                      <button
                        className="btn-danger !px-3 !py-1.5 text-xs"
                        onClick={() => remove(item.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> 删除
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
