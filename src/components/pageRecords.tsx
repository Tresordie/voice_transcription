// 页面记录区：各功能页展示本页（按 source 过滤）的历史记录，支持全文预览、载入结果区、下载 TXT
import { useCallback, useEffect, useState } from 'react'
import { Download, History, Upload } from 'lucide-react'
import { HISTORY_CHANGED_EVENT, listHistory, type HistoryItem } from '../lib/store/history'
import { downloadText, formatDate, formatDuration, timestampName } from '../lib/utils'

export default function PageRecordsSection({
  source,
  onLoad,
  filePrefix,
}: {
  source: 'live' | 'file'
  /** 载入到当前页面结果区（是否需要确认替换由页面自行判断） */
  onLoad: (item: HistoryItem) => void
  /** 下载 TXT 的文件名前缀 */
  filePrefix: string
}) {
  const [items, setItems] = useState<HistoryItem[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    const all = await listHistory()
    setItems(all.filter((x) => x.source === source))
  }, [source])

  // 挂载即加载；任何记录变更（存入/删除/清空/导入）自动刷新
  useEffect(() => {
    void refresh()
    const onChange = () => void refresh()
    window.addEventListener(HISTORY_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(HISTORY_CHANGED_EVENT, onChange)
  }, [refresh])

  if (items.length === 0) return null

  const toggle = (id: string) => {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2">
        <History className="h-4 w-4 text-zinc-400" />
        <p className="text-sm font-medium">历史记录</p>
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          {items.length} 条
        </span>
      </div>
      <div className="mt-3 flex max-h-80 flex-col gap-2 overflow-y-auto">
        {items.map((item) => {
          const open = expanded.has(item.id)
          return (
            <div key={item.id} className="rounded-xl border border-zinc-100 dark:border-zinc-800">
              <div className="flex items-center justify-between gap-2 px-3 pt-2">
                <p className="min-w-0 flex-1 truncate text-xs text-zinc-400">
                  {formatDate(item.createdAt)} · {item.engine}
                  {item.durationSec > 0 && ` · ${formatDuration(item.durationSec)}`}
                </p>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    className="btn-secondary !px-2 !py-0.5 !text-[11px]"
                    title="载入到当前页面"
                    onClick={() => onLoad(item)}
                  >
                    <Upload className="h-3 w-3" /> 载入
                  </button>
                  <button
                    className="btn-secondary !px-2 !py-0.5 !text-[11px]"
                    title="下载 TXT"
                    onClick={() => downloadText(item.text, timestampName(filePrefix, 'txt'))}
                  >
                    <Download className="h-3 w-3" /> 下载
                  </button>
                </div>
              </div>
              <button className="w-full px-3 pb-2.5 pt-1 text-left" onClick={() => toggle(item.id)}>
                <p
                  className={`whitespace-pre-wrap break-all text-sm leading-6 text-zinc-600 dark:text-zinc-300 ${
                    open ? '' : 'line-clamp-2'
                  }`}
                >
                  {item.text || '（空）'}
                </p>
                {!open && <p className="mt-0.5 text-[11px] text-zinc-400">点击查看全文</p>}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
