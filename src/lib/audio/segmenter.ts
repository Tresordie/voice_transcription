// 实时链路分段器：把连续 PCM 切成固定时长 WAV 段交给在线 API（近实时）
import { encodeWav } from './wav'

export class LiveSegmenter {
  private buf: Int16Array[] = []
  private total = 0
  private seq = 0
  readonly sampleRate: number
  readonly segmentSamples: number

  /** 每凑满一段回调一次 */
  onSegment?: (wav: Blob, seq: number) => void

  constructor(sampleRate = 16000, segmentMs = 4000) {
    this.sampleRate = sampleRate
    this.segmentSamples = Math.round((segmentMs / 1000) * sampleRate)
  }

  push(pcm: Int16Array): void {
    this.buf.push(pcm)
    this.total += pcm.length
    while (this.total >= this.segmentSamples) {
      const merged = this.drain(this.segmentSamples)
      const wav = encodeWav(merged, this.sampleRate)
      this.onSegment?.(wav, this.seq++)
    }
  }

  // 取出 n 个样本；不足时补静音，保证段长一致（在线端行为更稳定）
  private drain(n: number): Int16Array {
    const out = new Int16Array(n)
    let off = 0
    while (off < n && this.buf.length > 0) {
      const head = this.buf[0]
      const take = Math.min(head.length, n - off)
      out.set(head.subarray(0, take), off)
      if (take < head.length) this.buf[0] = head.subarray(take)
      else this.buf.shift()
      off += take
    }
    this.total -= off
    return out
  }

  // 丢弃不足一段的残余
  reset(): void {
    this.buf = []
    this.total = 0
  }

  // 结束时残余 ≥0.5s 则作为最后一段返回
  flush(): Blob | null {
    const rest = this.total
    this.reset()
    if (rest < this.sampleRate / 2) return null
    return encodeWav(this.drain(rest), this.sampleRate)
  }
}
