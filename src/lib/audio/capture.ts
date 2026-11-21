// 麦克风采集：AudioWorklet 输出 16kHz Int16 PCM + 电平，MediaRecorder 并行录制 webm
import { toPcm16k } from './wav'

export interface MicHooks {
  onPcm16?: (pcm: Int16Array) => void
  onLevel?: (rms: number) => void
}

export class MicRecorder {
  private stream?: MediaStream
  private ctx?: AudioContext
  private source?: MediaStreamAudioSourceNode
  private worklet?: AudioWorkletNode
  private recorder?: MediaRecorder
  private chunks: Blob[] = []
  private activeFlag = false

  get active(): boolean {
    return this.activeFlag
  }

  async start(hooks: MicHooks): Promise<void> {
    if (this.activeFlag) throw new Error('已在录音中')
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    this.ctx = new AudioContext()
    await this.ctx.resume()
    const workletUrl = `${import.meta.env.BASE_URL}worklets/pcm-collector.js`
    await this.ctx.audioWorklet.addModule(workletUrl)

    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.worklet = new AudioWorkletNode(this.ctx, 'pcm-collector')
    const ctxRef = this.ctx
    this.worklet.port.onmessage = (e) => {
      const f32 = e.data as Float32Array
      let sum = 0
      for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i]
      hooks.onLevel?.(Math.sqrt(sum / f32.length))
      hooks.onPcm16?.(toPcm16k(f32, ctxRef.sampleRate))
    }
    this.source.connect(this.worklet)
    // 不连接 destination，避免回声

    this.chunks = []
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'
    this.recorder = new MediaRecorder(this.stream, { mimeType: mime })
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }
    this.recorder.start(1000)
    this.activeFlag = true
  }

  // 停止采集，返回 MediaRecorder 录制的原始音频（webm/opus）
  async stop(): Promise<Blob> {
    if (!this.activeFlag || !this.recorder) throw new Error('未在录音中')
    this.activeFlag = false
    const blob = await new Promise<Blob>((resolve) => {
      this.recorder!.onstop = () =>
        resolve(new Blob(this.chunks, { type: this.recorder!.mimeType }))
      this.recorder!.stop()
    })
    this.worklet?.port.close()
    this.worklet?.disconnect()
    this.source?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    await this.ctx?.close()
    this.worklet = undefined
    this.source = undefined
    this.stream = undefined
    this.ctx = undefined
    return blob
  }
}
