import { useEffect, useState } from 'react'
import {
  AudioLines,
  FileAudio2,
  History,
  Moon,
  Settings,
  Sparkles,
  Sun,
} from 'lucide-react'
import { SettingsProvider, useSettings } from './lib/store/settings'
import { ToastProvider } from './components/toast'
import LivePage from './pages/LivePage'
import FilePage from './pages/FilePage'
import AiPage from './pages/AiPage'
import HistoryPage from './pages/HistoryPage'
import SettingsPage from './pages/SettingsPage'

export type View = 'live' | 'file' | 'ai' | 'history' | 'settings'

const NAV: { id: View; label: string; icon: typeof AudioLines }[] = [
  { id: 'live', label: '实时转录', icon: AudioLines },
  { id: 'file', label: '文件转写', icon: FileAudio2 },
  { id: 'ai', label: 'AI 总结', icon: Sparkles },
  { id: 'history', label: '历史记录', icon: History },
  { id: 'settings', label: '设置', icon: Settings },
]

function Shell() {
  const [view, setView] = useState<View>('live')
  const { settings, update } = useSettings()

  // 主题应用：跟随系统 / 浅色 / 深色
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark =
        settings.theme === 'dark' ||
        (settings.theme === 'system' && mq.matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings.theme])

  const isDark = document.documentElement.classList.contains('dark')
  const toggleTheme = () => {
    update({ theme: isDark ? 'light' : 'dark' })
  }

  // 切页时重播入场动画（页面保持挂载，需手动重触发 CSS 动画）
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(`[data-page="${view}"]`)
    if (el) {
      el.classList.remove('animate-fade-up')
      void el.offsetWidth // 强制重排以重启动画
      el.classList.add('animate-fade-up')
    }
  }, [view])

  return (
    <div className="flex h-screen overflow-hidden">
      {/* 侧边栏（桌面） */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-zinc-200 bg-white px-4 py-6 dark:border-zinc-800 dark:bg-zinc-900 md:flex">
        <div className="mb-8 flex items-center gap-3 px-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl accent-gradient shadow-md">
            <AudioLines className="h-5 w-5 text-white" />
          </div>
          <div>
            <div className="font-semibold tracking-wide">VoiceTrans</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">网页端语音转写</div>
          </div>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                view === id
                  ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400'
                  : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
              }`}
            >
              <Icon className="h-4.5 w-4.5" />
              {label}
            </button>
          ))}
        </nav>
        <div className="mt-auto flex items-center justify-between px-2">
          <button
            onClick={toggleTheme}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            title="切换主题"
          >
            {isDark ? <Sun className="h-4.5 w-4.5" /> : <Moon className="h-4.5 w-4.5" />}
          </button>
          <span className="text-xs text-zinc-400 dark:text-zinc-500">v0.1.0</span>
        </div>
      </aside>

      {/* 顶栏（移动端） */}
      <div className="fixed inset-x-0 top-0 z-40 flex items-center justify-between border-b border-zinc-200 bg-white/90 px-4 py-3 backdrop-blur md:hidden dark:border-zinc-800 dark:bg-zinc-900/90">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg accent-gradient">
            <AudioLines className="h-4 w-4 text-white" />
          </div>
          <span className="font-semibold">VoiceTrans</span>
        </div>
        <div className="flex items-center gap-1">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
                view === id
                  ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400'
                  : 'text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
              }`}
              title={label}
            >
              <Icon className="h-4.5 w-4.5" />
            </button>
          ))}
        </div>
      </div>

      {/* 主内容：五个页面保持挂载（切页不丢输入状态），用 hidden 切换可见性 */}
      <main className="flex-1 overflow-y-auto pt-16 md:pt-0">
        <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-10">
          <div data-page="live" className={view === 'live' ? 'animate-fade-up' : 'hidden'}>
            <LivePage active={view === 'live'} />
          </div>
          <div data-page="file" className={view === 'file' ? 'animate-fade-up' : 'hidden'}>
            <FilePage />
          </div>
          <div data-page="ai" className={view === 'ai' ? 'animate-fade-up' : 'hidden'}>
            <AiPage />
          </div>
          <div data-page="history" className={view === 'history' ? 'animate-fade-up' : 'hidden'}>
            <HistoryPage active={view === 'history'} />
          </div>
          <div data-page="settings" className={view === 'settings' ? 'animate-fade-up' : 'hidden'}>
            <SettingsPage />
          </div>
        </div>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <SettingsProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </SettingsProvider>
  )
}
