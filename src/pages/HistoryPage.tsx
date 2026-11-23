// 历史记录页：git 备份管理——全量导出/导入 JSON、定时自动推送、备份版本浏览/预览/恢复
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Download,
  Trash2,
  Upload,
} from 'lucide-react'
import {
  clearHistory,
  importHistoryItems,
  listHistory,
  type HistoryItem,
} from '../lib/store/history'
import { useToast } from '../components/toast'
import { downloadText, formatDate, formatDuration, timestampName } from '../lib/utils'

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
interface BackupVersion {
  hash: string
  date: string
  message: string
}
interface BackupVersionsResult {
  ok: boolean
  versions?: BackupVersion[]
  error?: string
}
interface BackupVersionContentResult {
  ok: boolean
  content?: string
  error?: string
}

const remoteName = (url: string) =>
  url.includes('github') ? 'GitHub' : url.includes('gitee') ? 'Gitee' : url

// 记录来源展示名（备份版本预览用）
const SOURCE_LABEL: Record<HistoryItem['source'], string> = {
  live: '实时转录',
  file: '文件转写',
  ai: 'AI 总结',
}

// 自动备份间隔（分钟），存 localStorage；0 = 关闭
const BACKUP_INTERVAL_KEY = 'vt:backupInterval'
const BACKUP_INTERVAL_OPTIONS = [1, 5, 15, 30]
const BACKUP_INTERVAL_DEFAULT = 5

export default function HistoryPage({ active = true }: { active?: boolean }) {
  const { show: showToast } = useToast()
  const [items, setItems] = useState<HistoryItem[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null)
  const [backupResult, setBackupResult] = useState<BackupOpResult | null>(null)
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupVersions, setBackupVersions] = useState<BackupVersion[]>([])
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [preview, setPreview] = useState<{ version: BackupVersion; items: HistoryItem[] } | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [backupIntervalMin, setBackupIntervalMin] = useState<number>(() => {
    const v = Number(localStorage.getItem(BACKUP_INTERVAL_KEY))
    return Number.isFinite(v) && (v === 0 || BACKUP_INTERVAL_OPTIONS.includes(v)) ? v : BACKUP_INTERVAL_DEFAULT
  })
  // 上次自动备份的内容指纹与结果：内容未变且上次推送全部成功时跳过本轮
  const lastBackupRef = useRef<{ itemsJson: string; allOk: boolean } | null>(null)
  const lastTickOkRef = useRef<boolean | null>(null)

  const refresh = useCallback(async () => {
    setItems(await listHistory())
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
    try {
      const r = await fetch('/backup-api/versions')
      const data: BackupVersionsResult = await r.json()
      // 接口返回最近 50 条，界面仅展示最近 5 条
      setBackupVersions(r.ok && data.ok ? data.versions?.slice(0, 5) ?? [] : [])
    } catch {
      setBackupVersions([])
    }
  }, [])

  // 备份服务状态挂载即获取（页面常驻，自动备份不依赖本页可见）
  useEffect(() => {
    void loadBackupStatus()
  }, [loadBackupStatus])

  // 页面保持挂载：每次切回本页时刷新列表（备份内容以最新记录为准）
  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh])

  const removeAll = async () => {
    if (items.length === 0) return
    if (!window.confirm(`确定清空全部 ${items.length} 条历史记录吗？`)) return
    await clearHistory()
    setItems([])
    showToast('info', '历史已清空')
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
      lastBackupRef.current = { itemsJson: JSON.stringify(items), allOk }
      lastTickOkRef.current = allOk
      const names = pushed.map((p) => `${remoteName(p.url)}${p.ok ? ' ✓' : ' ✗'}`).join(' · ')
      showToast(
        allOk ? 'success' : 'error',
        data.committed ? `已备份并推送（${names}）` : `内容无变化，已同步（${names}）`,
      )
    } catch {
      downloadText(text, timestampName('历史备份', 'json'))
      showToast('info', '备份服务未连接，已改为浏览器下载')
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
        showToast(allOk ? 'success' : 'error', names ? `推送完成（${names}）` : '未找到推送地址')
      } else {
        showToast('error', data.error || '推送失败')
      }
    } catch {
      showToast('error', '备份服务未连接')
    } finally {
      setBackupBusy(false)
    }
  }

  // 预览指定备份版本：解析其中的转录记录供查看/导入
  const openPreview = async (version: BackupVersion) => {
    setPreviewBusy(true)
    try {
      const r = await fetch(`/backup-api/version?hash=${version.hash}`)
      const data: BackupVersionContentResult = await r.json()
      if (!r.ok || !data.ok || typeof data.content !== 'string') {
        throw new Error(data.error || `HTTP ${r.status}`)
      }
      const parsed = JSON.parse(data.content) as { items?: unknown }
      const items = Array.isArray(parsed) ? parsed : parsed?.items
      if (!Array.isArray(items)) throw new Error('缺少 items 数组')
      setPreview({ version, items: items as HistoryItem[] })
    } catch (e) {
      showToast('error', `预览失败：${(e as Error).message}`)
    } finally {
      setPreviewBusy(false)
    }
  }

  // 下载指定备份版本的 JSON 文件
  const downloadVersion = async (version: BackupVersion) => {
    setPreviewBusy(true)
    try {
      const r = await fetch(`/backup-api/version?hash=${version.hash}`)
      const data: BackupVersionContentResult = await r.json()
      if (!r.ok || !data.ok || typeof data.content !== 'string') {
        throw new Error(data.error || `HTTP ${r.status}`)
      }
      downloadText(data.content, `历史备份-${version.date.slice(0, 10)}-${version.hash.slice(0, 7)}.json`)
      showToast('success', '已下载')
    } catch (e) {
      showToast('error', `下载失败：${(e as Error).message}`)
    } finally {
      setPreviewBusy(false)
    }
  }

  // 把预览中的备份记录按 id 合并回灌到应用（不覆盖已有记录）
  const importPreview = async () => {
    if (!preview) return
    try {
      const { added, skipped } = await importHistoryItems(preview.items)
      await refresh()
      showToast('success', `导入 ${added} 条${skipped > 0 ? `，跳过 ${skipped} 条` : ''}`)
    } catch (e) {
      showToast('error', `导入失败：${(e as Error).message}`)
    }
  }

  // 自动备份单次执行：有新转录才提交推送，内容无变化且上次已成功则跳过
  const autoTick = useCallback(async () => {
    try {
      const r = await fetch('/backup-api/status')
      if (!r.ok) return
      if (!((await r.json()) as BackupStatus)?.connected) return
    } catch {
      return // 服务不可达，静默等待下一轮
    }
    const items = await listHistory()
    if (items.length === 0) return
    const itemsJson = JSON.stringify(items)
    const last = lastBackupRef.current
    if (last && last.itemsJson === itemsJson && last.allOk) return
    setBackupBusy(true)
    try {
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        count: items.length,
        items,
      }
      const r = await fetch('/backup-api/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload, null, 2),
      })
      const data: BackupOpResult = await r.json()
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setBackupResult(data)
      void loadBackupStatus()
      const pushed = data.pushed ?? []
      const allOk = pushed.length > 0 && pushed.every((p) => p.ok)
      lastBackupRef.current = { itemsJson, allOk }
      // 仅在失败/恢复的状态切换时提示，避免每轮弹窗刷屏
      if (!allOk && lastTickOkRef.current !== false) {
        const failed = pushed.filter((p) => !p.ok).map((p) => remoteName(p.url)).join('、')
        showToast('error', `自动备份推送失败：${failed || '未知远端'}`)
      } else if (allOk && lastTickOkRef.current === false) {
        showToast('success', '自动备份推送已恢复')
      }
      lastTickOkRef.current = allOk
    } catch (e) {
      if (lastTickOkRef.current !== false) showToast('error', `自动备份失败：${(e as Error).message}`)
      lastTickOkRef.current = false
    } finally {
      setBackupBusy(false)
    }
  }, [showToast, loadBackupStatus])

  // 定时自动备份：启动后先检查一次（可重试上次失败），之后按设定间隔执行
  const backupConnected = backupStatus?.connected === true
  useEffect(() => {
    if (!backupConnected || backupIntervalMin === 0) return
    const tick = () => void autoTick()
    const first = setTimeout(tick, 3000)
    const timer = setInterval(tick, backupIntervalMin * 60_000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [backupConnected, backupIntervalMin, autoTick])

  // 导入 JSON 备份：按 id 合并去重，不覆盖已有记录
  const importAll = async (file: File) => {
    try {
      const data = JSON.parse(await file.text())
      const arr = Array.isArray(data) ? data : data?.items
      if (!Array.isArray(arr)) throw new Error('bad format')
      const { added, skipped } = await importHistoryItems(arr)
      await refresh()
      showToast('success', `导入 ${added} 条${skipped > 0 ? `，跳过 ${skipped} 条` : ''}`)
    } catch {
      showToast('error', '文件格式不正确')
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
            本地记录仅存于你的浏览器中，支持 JSON 备份与导入恢复；各页历史在对应功能页底部查看
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
          <div className="flex items-center gap-2">
            {backupStatus?.connected && (
              <label className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                自动备份
                <select
                  className="input !w-auto !rounded-lg !px-2 !py-1 text-xs"
                  value={backupIntervalMin}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    setBackupIntervalMin(v)
                    localStorage.setItem(BACKUP_INTERVAL_KEY, String(v))
                  }}
                >
                  {BACKUP_INTERVAL_OPTIONS.concat(0).map((v) => (
                    <option key={v} value={v}>
                      {v === 0 ? '关闭' : `每 ${v} 分钟`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              className="btn-secondary !px-3 !py-1.5 text-xs"
              disabled={!backupStatus?.connected || backupBusy}
              onClick={() => void pushBackup()}
            >
              推送
            </button>
          </div>
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
        {backupStatus?.connected && (
          <div className="border-t border-zinc-100 pt-2 dark:border-zinc-800">
            <button
              className="flex items-center gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-300"
              onClick={() => setVersionsOpen((v) => !v)}
            >
              {versionsOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              备份历史（{backupVersions.length}）
            </button>
            {versionsOpen && (
              <div className="mt-1.5 flex flex-col gap-0.5">
                {backupVersions.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-zinc-400">暂无备份版本</p>
                ) : (
                  backupVersions.map((v) => (
                    <div
                      key={v.hash}
                      className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                      title={v.message}
                    >
                      <span className="shrink-0 font-mono text-zinc-400">{v.hash.slice(0, 7)}</span>
                      <span className="min-w-0 flex-1 truncate text-zinc-500 dark:text-zinc-400">
                        {formatDate(new Date(v.date).getTime())}
                      </span>
                      <button
                        className="btn-secondary !px-2 !py-0.5 !text-[11px]"
                        disabled={previewBusy}
                        onClick={() => void openPreview(v)}
                      >
                        预览
                      </button>
                      <button
                        className="btn-secondary !px-2 !py-0.5 !text-[11px]"
                        disabled={previewBusy}
                        onClick={() => void downloadVersion(v)}
                      >
                        下载
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {preview && (
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-700">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-2.5">
              <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                版本预览 {preview.version.hash.slice(0, 7)} · {preview.items.length} 条记录
              </p>
              <div className="flex items-center gap-1.5">
                <button className="btn-secondary !px-2 !py-0.5 !text-[11px]" onClick={() => void importPreview()}>
                  导入此版本
                </button>
                <button className="btn-secondary !px-2 !py-0.5 !text-[11px]" onClick={() => setPreview(null)}>
                  关闭
                </button>
              </div>
            </div>
            <div className="max-h-72 overflow-y-auto px-3 pb-3 pt-2">
              {preview.items.length === 0 ? (
                <p className="text-xs text-zinc-400">此版本没有记录</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {preview.items.map((it) => (
                    <div key={it.id} className="rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800/60">
                      <p className="text-[11px] text-zinc-400">
                        {formatDate(it.createdAt)} · {SOURCE_LABEL[it.source]} · {it.engine}
                        {it.durationSec > 0 && ` · ${formatDuration(it.durationSec)}`}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap break-all text-sm leading-6">{it.text || '（空）'}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
