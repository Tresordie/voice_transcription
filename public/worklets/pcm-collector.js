// AudioWorklet：采集原始 Float32 音频块并送到主线程
// 主线程负责重采样到 16kHz、转 Int16 及电平计算
class PCMCollector extends AudioWorkletProcessor {
  constructor() {
    super()
    // 缓冲 2048 帧再发送一次，减少消息频率
    this._buffer = new Float32Array(2048)
    this._offset = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    // 取第一个声道（已请求单声道）
    const ch = input[0]
    for (let i = 0; i < ch.length; i++) {
      this._buffer[this._offset++] = ch[i]
      if (this._offset === this._buffer.length) {
        this.port.postMessage(this._buffer.slice(0))
        this._offset = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-collector', PCMCollector)
