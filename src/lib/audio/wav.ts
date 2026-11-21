// 音频工具：格式转换、重采样、WAV 编码、文件解码

export function floatToInt16(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    let s = f32[i]
    if (s > 1) s = 1
    else if (s < -1) s = -1
    out[i] = s < 0 ? s * 32768 : s * 32767
  }
  return out
}

// 均值抽取降采样（麦克风实时链路用，48k→16k 整数倍比例下质量足够）
export function downsample(
  f32: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return f32
  const ratio = fromRate / toRate
  const newLen = Math.floor(f32.length / ratio)
  const out = new Float32Array(newLen)
  for (let i = 0; i < newLen; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(Math.floor((i + 1) * ratio), f32.length)
    let sum = 0
    let n = 0
    for (let j = start; j < end; j++) {
      sum += f32[j]
      n++
    }
    out[i] = n > 0 ? sum / n : 0
  }
  return out
}

// Float32（任意采样率）→ 16kHz Int16 PCM
export function toPcm16k(f32: Float32Array, fromRate: number): Int16Array {
  return floatToInt16(downsample(f32, fromRate, 16000))
}

// Int16 PCM → WAV Blob（标准 RIFF 头）
export function encodeWav(pcm: Int16Array, sampleRate: number): Blob {
  const buf = new ArrayBuffer(44 + pcm.length * 2)
  const view = new DataView(buf)
  const w = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  w(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  w(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  let off = 44
  for (let i = 0; i < pcm.length; i++, off += 2) view.setInt16(off, pcm[i], true)
  return new Blob([view], { type: 'audio/wav' })
}

export interface DecodedAudio {
  pcm: Int16Array
  sampleRate: number
  durationSec: number
}

// 任意音频文件 → 16kHz 单声道 PCM（用 OfflineAudioContext 做高质量重采样）
export async function decodeToPcm16k(blob: Blob): Promise<DecodedAudio> {
  const arr = await blob.arrayBuffer()
  const ac = new AudioContext()
  try {
    const audio = await ac.decodeAudioData(arr)
    const targetRate = 16000
    const frames = Math.max(1, Math.ceil(audio.duration * targetRate))
    const oc = new OfflineAudioContext(1, frames, targetRate)
    const src = oc.createBufferSource()
    src.buffer = audio
    src.connect(oc.destination)
    src.start()
    const rendered = await oc.startRendering()
    const f32 = rendered.getChannelData(0)
    return { pcm: floatToInt16(f32), sampleRate: targetRate, durationSec: audio.duration }
  } finally {
    void ac.close()
  }
}
