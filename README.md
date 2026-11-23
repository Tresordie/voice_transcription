# VoiceTrans · 网页端语音转写

界面精美、开箱即用的网页端语音转写工具：**实时语音转录** + **录音文件转文字** + **AI 总结**。

双引擎设计，识别率和隐私由你选择：

| 引擎 | 说明 | 适合场景 |
|---|---|---|
| 🖥️ **本地模型** | sherpa-onnx WASM 在浏览器内离线推理（流式 Zipformer 中英 + 非流式 SenseVoice 多语种高精度），数据不出设备 | 隐私敏感、无网络环境 |
| ☁️ **在线 API** | 自带 API Key（BYOK），支持硅基流动 / 阿里百炼及任意 OpenAI 兼容服务 | 追求最高准确率 |

> 维护者/接手开发请先阅读 [PROJECT_HANDOFF.md](./PROJECT_HANDOFF.md)（架构决策、已知坑、维护指南）。

## 功能

- **实时转录**：麦克风采集 → 逐字流式显示（本地引擎）或 4 秒分段近实时（在线引擎），波形可视化、录音保存
- **文件转写**：拖拽上传 wav / mp3 / m4a / ogg / webm 等，自动重采样、长文件自动分段
- **AI 总结**：文本 / 附件（≤150MB，文档直接解析、音频自动转写）→ 自定义大模型按 25 套预设模板或自定义提示词生成结构化总结；超长文档自动分块理解全文；结果支持 Markdown / HTML / PDF / Word / Excel / PPT 导出与微信格式一键复制
- **历史记录**：转录结果本地持久化（IndexedDB），支持复制 / 导出 TXT；全量导出/导入 JSON；dev 模式内置 git 备份服务，运行期间定时自动推送（默认 5 分钟，可调/可关）到 [voice_transcription_database](https://github.com/Tresordie/voice_transcription_database) 仓库（GitHub + Gitee 双端），也可手动一键推送
- **开箱即用**：模型下载一次后缓存，离线可用；API Key 只存你的浏览器

## 快速开始

> 要求：Node.js ≥ 18

```bash
npm install
npm run dev
```

打开 http://localhost:5173 即可使用。

> **麦克风权限**：浏览器仅在 `https` 或 `localhost` 下开放麦克风，本地开发直接可用。

### 使用本地模型

1. 进入「设置」页 → 引擎选择「本地模型」
2. 按需下载模型（从 HuggingFace 镜像下载，国内可直连，缓存后离线可用）：
   - **Zipformer 中英双语 · 流式**（约 190MB）：实时转录逐字出字
   - **SenseVoice 多语种 · 高精度**（约 228MB）：文件转写用，中文准确率显著更高，自动标点与数字规整
3. 实时转录走 Zipformer；文件转写在 SenseVoice 已下载时自动切换到高精度引擎，否则回落 Zipformer

### 使用在线 API

1. 进入「设置」页 → 引擎选择「在线 API」
2. 选择服务商预设（推荐 **硅基流动**：SenseVoiceSmall 模型**免费**、国内直连）
3. 填入 API Key，点击「测试连接」确认

| 服务商 | 默认模型 | 费用 | 说明 |
|---|---|---|---|
| 硅基流动 | FunAudioLLM/SenseVoiceSmall | **免费** | 国内直连，无需代理 |
| 阿里百炼 | qwen3-asr-flash | 北京地域有免费额度（90 天） | 中文准确率高、支持方言；必须走内置代理 |
| 自定义 | 任意 OpenAI 兼容 /audio/transcriptions 服务 | 按服务商定价 | |

> - OpenAI / Groq 已从默认预设移除，仍可通过「自定义」接入（Base URL + Key + 模型名）
> - 阿里百炼域名（dashscope/maas.aliyuncs.com）自动识别为 Qwen-ASR 协议，并按 6 种请求形态自动探测（`chat/completions + input_audio` 的 4 种字段形态 → multipart `/audio/transcriptions` → DashScope 原生 `multimodal-generation`），成功即用。注意 `fun-asr-realtime` 等 `-realtime` 后缀模型仅支持 WebSocket 实时协议，无法经 HTTP 接口调用；订阅制 Token Plan 端点不支持语音识别
> - 设置页支持**热词 / 上下文**：填入专有名词、人名、品牌或背景说明，提高识别准确率（Qwen-ASR 走识别上下文，OpenAI 兼容服务走 prompt 字段）

### 使用 AI 总结

1. 进入「设置」页 → 「AI 总结服务」区块，填入任意 OpenAI 兼容大模型的 Base URL / API Key / 模型名（如硅基流动、阿里百炼、DeepSeek、GLM），点「测试连接」确认
2. 进入「AI 总结」页 → 粘贴文本或上传附件（pdf / docx / xlsx / pptx / txt 直接提取文本；音频自动转写；单文件 ≤150MB）→ 也可「从历史导入」转写记录
3. 选择预设模板（25 套：会议纪要 / 日报周报 / 任务提取 / 邮件总结 / 邮件撰写）或自由总结，可叠加自定义提示词
4. 生成后一键导出 Markdown / HTML / PDF / Word / Excel / PPT，或复制「微信格式」直接粘贴到微信发送

> 超长文档会自动分块理解全文后再总结（map-reduce）；模板来自 [scenario-templates](./scripts/extract-templates.mjs) 数据源，可用 `node scripts/extract-templates.mjs` 重新生成。

## 隐私与安全

- **无后端**：纯前端静态应用，没有服务器
- **API Key**：仅存于浏览器 `localStorage`，请求由浏览器直连服务商
- **本地模式**：录音与识别全程在浏览器内完成，可断网使用

## 遇到 CORS 拦截？

个别服务商不允许浏览器直连时，可启动附带的可选代理（只做透明转发）：

```bash
npm run proxy
# 然后把 Base URL 改为 http://localhost:8787/proxy/<服务商BaseURL>
# 例如 http://localhost:8787/proxy/https://api.openai.com/v1
```

开发模式（`npm run dev`）已内置同款代理：直接把 Base URL 填为 `http://localhost:5173/proxy/<服务商BaseURL>`，或在设置页点「改用内置代理」一键转换。

## 构建与部署

```bash
npm run build   # 产物在 dist/
npm run preview # 本地预览构建产物
```

`dist/` 是纯静态目录，可部署到任意静态托管。注意：
- 必须通过 **HTTPS**（或 localhost）访问，否则浏览器拒绝麦克风
- 静态托管需支持较大文件的正常分发（本地模型 .data 在运行时按需下载，不占构建产物体积）

## 部署与分发（在其他电脑上使用）

按场景选择：

**① 其他电脑上直接运行（自用最快）**：装 Node.js ≥ 18 → `git clone` → `npm install` → `npm run dev` → 打开 `http://localhost:5173`（localhost 天然可用麦克风，Windows/macOS 命令一致）。

**② 部署 HTTPS 网站，任何人浏览器即开即用（推荐正式使用）**：`npm run build` 后把 `dist/` 交给任意静态托管（Cloudflare Pages / Vercel / Netlify / GitHub Pages / Gitee Pages / 自有服务器 nginx）。HTTPS 与证书由托管方提供；每次 `git push` 自动更新。

**③ 局域网 IP 直访**：仅能演示界面——浏览器在非安全上下文（HTTP+IP）下禁用麦克风和 Cache API，无法转录。

| 注意事项 | 说明 |
|---|---|
| 数据按设备隔离 | 模型缓存（流式 190MB / 高精度 228MB）、API Key、历史记录均存各自浏览器 |
| 免下载使用 | 在线模式 + 硅基流动免费 Key，开箱即用 |
| 企业内网 | 用自签/内部 CA 证书做 HTTPS（方案见 PROJECT_HANDOFF.md §6） |

## 技术栈

- Vite + React 18 + TypeScript + Tailwind CSS v4
- 本地引擎：[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) WASM（Apache-2.0），官方 streaming zipformer 中英双语 int8 模型
- 音频链路：AudioWorklet 采集 → 16kHz PCM → 流式识别 / WAV 分段上传
- 存储：localStorage（设置）+ IndexedDB（历史）+ Cache API（模型）

## 目录结构

```
├── public/sherpa/        # 本地引擎运行时（wasm + 官方封装层；offline/ 为自建离线构建）
├── public/worklets/      # AudioWorklet 采集器
├── src/
│   ├── lib/
│   │   ├── audio/        # 采集、WAV 编解码、重采样、分段器
│   │   ├── asr/          # 本地流式引擎、离线高精度引擎（SenseVoice）、在线客户端（OpenAI 兼容 + 百炼协议探测）
│   │   ├── ai/           # AI 总结：模板库（25 套）、LLM 客户端、附件提取、map-reduce 编排、多格式导出、微信格式
│   │   ├── models/       # 模型目录与下载缓存
│   │   └── store/        # 设置、历史
│   ├── pages/            # 实时转录 / 文件转写 / AI 总结 / 历史 / 设置
│   └── components/       # Toast、波形、Markdown 渲染等
├── scripts/              # 模板数据提取脚本
├── proxy.mjs             # 可选 CORS 透明代理
└── vite.config.ts
```

## Roadmap

- [ ] 本地高精度文件模型（SenseVoice，需自建 wasm/web 运行时）
- [ ] 转写结果导出 SRT 字幕
- [ ] 说话人分离（VAD + diarization）
- [ ] 热词增强
- [ ] Electron 桌面打包（双击运行，麦克风免配置，模型可选内置）

## License

MIT（本项目代码）。`public/sherpa/` 内的运行时文件来自 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（Apache-2.0）官方构建产物，版权归其作者所有。
