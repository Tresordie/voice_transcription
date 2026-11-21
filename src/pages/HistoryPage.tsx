// 历史记录页：转录结果列表、查看、复制、删除
import { useCallback, useEffect, useState } from 'react'
import {
  AudioLines,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileAudio2,
  History,
  Trash2,
} from 'lucide-react'
import {
  clearHistory,
  deleteHistoryItem,
  listHistory,
  type HistoryItem,
} from '../lib/store/history'
import { useToast } from '../components/toast'
import { copyText, downloadText, formatDate, formatDuration, timestampName } from '../lib/utils'

export default function HistoryPage() {
  const toast = useToast()
  const [items, setItems] = useState<HistoryItem[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await listHistory())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

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

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">历史记录</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            保存的转录结果仅存于你的浏览器中
          </p>
        </div>
        {items.length > 0 && (
          <button className="btn-danger" onClick={removeAll}>
            <Trash2 className="h-4 w-4" /> 清空
          </button>
        )}
      </header>

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
