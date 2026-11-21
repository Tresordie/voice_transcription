// 本地模型目录：wasm 运行时（glue/wasm/wrapper）已内置 /public/sherpa，
// 模型 .data 包体积大，采用运行时下载 + Cache API 缓存。

export interface LocalModelInfo {
  id: string
  name: string
  desc: string
  /** .data 包精确字节数（用于展示与校验） */
  dataBytes: number
  /** 下载地址，按优先级排列（镜像优先，国内可直连） */
  dataUrls: string[]
  dataFilename: string
}

// 官方 wasm demo 构建：streaming zipformer 中英双语 int8（约 190MB）
// 来源 HF Space echoyzd/web-assembly-asr-sherpa-onnx-zh-en
const DATA_FILE = 'sherpa-onnx-wasm-main-asr.data'

export const ZIPFORMER_ZH_EN: LocalModelInfo = {
  id: 'zipformer-zh-en-streaming',
  name: 'Zipformer 中英双语 · 流式',
  desc: '实时逐字识别，中英混说能力强；int8 量化版，约 190MB，下载一次后本地缓存',
  dataBytes: 199059238,
  dataUrls: [
    `https://hf-mirror.com/spaces/echoyzd/web-assembly-asr-sherpa-onnx-zh-en/resolve/main/${DATA_FILE}`,
    `https://huggingface.co/spaces/echoyzd/web-assembly-asr-sherpa-onnx-zh-en/resolve/main/${DATA_FILE}`,
  ],
  dataFilename: DATA_FILE,
}

export const LOCAL_MODELS: LocalModelInfo[] = [ZIPFORMER_ZH_EN]
