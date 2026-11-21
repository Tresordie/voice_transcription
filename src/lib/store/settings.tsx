// 应用设置：React Context + localStorage 持久化
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { PROVIDERS, type ProviderId, type Transport } from '../asr/online'

export type EngineMode = 'local' | 'online'
export type Language = 'auto' | 'zh' | 'en'
export type ThemeMode = 'system' | 'light' | 'dark'

export interface AppSettings {
  engineMode: EngineMode
  language: Language
  theme: ThemeMode
  provider: ProviderId
  baseURL: string
  apiKey: string
  model: string
  /** 在线请求协议，随服务商预设自动切换 */
  transport: Transport
}

const STORAGE_KEY = 'vt:settings'

const DEFAULTS: AppSettings = {
  engineMode: 'local',
  language: 'auto',
  theme: 'system',
  provider: 'siliconflow',
  baseURL: PROVIDERS.siliconflow.baseURL,
  apiKey: '',
  model: 'FunAudioLLM/SenseVoiceSmall',
  transport: 'transcriptions',
}

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const merged = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) }
    // 旧版本可能存有已下线的服务商预设：回退到默认并重置相关字段
    if (!PROVIDERS[merged.provider]) {
      return {
        ...merged,
        provider: DEFAULTS.provider,
        baseURL: DEFAULTS.baseURL,
        model: DEFAULTS.model,
      }
    }
    return merged
  } catch {
    return DEFAULTS
  }
}

interface SettingsCtxValue {
  settings: AppSettings
  update: (patch: Partial<AppSettings>) => void
  /** 按当前 provider 重置 baseURL/model */
  applyProvider: (provider: ProviderId) => void
}

const Ctx = createContext<SettingsCtxValue | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(load)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  }, [settings])

  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings((s) => ({ ...s, ...patch }))
  }, [])

  const applyProvider = useCallback((provider: ProviderId) => {
    setSettings((s) => {
      const p = PROVIDERS[provider]
      return {
        ...s,
        provider,
        baseURL: p.baseURL || s.baseURL,
        model: p.models[0] ?? s.model,
        transport: p.transport ?? 'transcriptions',
      }
    })
  }, [])

  const value = useMemo(
    () => ({ settings, update, applyProvider }),
    [settings, update, applyProvider],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSettings(): SettingsCtxValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSettings 必须在 SettingsProvider 内使用')
  return v
}
