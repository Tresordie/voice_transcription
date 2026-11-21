// 轻量 Toast：顶部居中浮层，自动消失
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, Info } from 'lucide-react'

type ToastKind = 'success' | 'error' | 'info'
interface ToastItem {
  id: number
  kind: ToastKind
  text: string
}

const Ctx = createContext<{ show: (kind: ToastKind, text: string) => void } | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)

  const show = useCallback((kind: ToastKind, text: string) => {
    const id = ++seq.current
    setItems((xs) => [...xs.slice(-4), { id, kind, text }])
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3000)
  }, [])

  return (
    <Ctx.Provider value={{ show }}>
      {children}
      <div className="pointer-events-none fixed top-4 left-1/2 z-50 flex w-[min(92vw,520px)] -translate-x-1/2 flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className="animate-fade-up card pointer-events-auto flex items-start gap-2.5 px-4 py-3 text-sm shadow-lg"
          >
            {t.kind === 'success' && (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
            )}
            {t.kind === 'error' && (
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            )}
            {t.kind === 'info' && (
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" />
            )}
            <span className="break-all">{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export function useToast() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useToast 必须在 ToastProvider 内使用')
  return v
}
