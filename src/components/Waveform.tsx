// 音量波形可视化：圆角条形图，indigo→violet 渐变
import { useEffect, useRef } from 'react'

export function Waveform({ levels, active }: { levels: number[]; active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = Math.max(1, Math.round(w * dpr))
    canvas.height = Math.max(1, Math.round(h * dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)

    const n = 64
    const gap = 3
    const bw = Math.max(2, (w - gap * (n - 1)) / n)
    for (let i = 0; i < n; i++) {
      const li = levels.length - n + i
      const v = active && li >= 0 ? Math.min(1, levels[li] * 6) : 0.03
      const bh = Math.max(3, v * (h - 8))
      const x = i * (bw + gap)
      const y = (h - bh) / 2
      if (active) {
        const grad = ctx.createLinearGradient(0, y, 0, y + bh)
        grad.addColorStop(0, '#6366f1')
        grad.addColorStop(1, '#8b5cf6')
        ctx.fillStyle = grad
      } else {
        ctx.fillStyle = 'rgba(161,161,170,0.4)'
      }
      ctx.beginPath()
      ctx.roundRect(x, y, bw, bh, bw / 2)
      ctx.fill()
    }
  }, [levels, active])

  return <canvas ref={ref} className="h-16 w-full" />
}
