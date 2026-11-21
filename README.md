# VoiceTrans · 网页端语音转写

界面精美、开箱即用的网页端语音转写工具：**实时语音转录** + **录音文件转文字**。

双引擎设计，识别率和隐私由你选择：

| 引擎 | 说明 | 适合场景 |
|---|---|---|
| 🖥️ **本地模型** | sherpa-onnx WASM 在浏览器内离线推理（streaming zipformer 中英双语），数据不出设备 | 隐私敏感、无网络环境 |
| ☁️ **在线 API** | 自带 API Key（BYOK），支持 OpenAI / Groq / 硅基流动及任意 OpenAI 兼容服务 | 追求最高准确率 |

> 维护者/接手开发请先阅读 [PROJECT_HANDOFF.md](./PROJECT_HANDOFF.md)（架构决策、已知坑、维护指南）。

## 功能

- **实时转录**：麦克风采集 → 逐字流式显示（本地引擎）或 4 秒分段近实时（在线引擎），波形可视化、录音保存
- **文件转写**：拖拽上传 wav / mp3 / m4a / ogg / webm 等，自动重采样、长文件自动分段
- **历史记录**：转录结果本地持久化（IndexedDB），支持复制 / 导出 TXT
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
2. 点击「下载模型」（约 190MB，从 HuggingFace 镜像下载，国内可直连）
3. 之后在实时转录 / 文件转写页即可离线使用

### 使用在线 API

1. 进入「设置」页 → 引擎选择「在线 API」
2. 选择服务商预设（推荐 **硅基流动**：SenseVoiceSmall 模型**免费**、国内直连）
3. 填入 API Key，点击「测试连接」确认

| 服务商 | 默认模型 | 费用 |
|---|---|---|
| 硅基流动 | FunAudioLLM/SenseVoiceSmall | **免费** |
| 自定义 | 任意 OpenAI 兼容 /audio/transcriptions 服务 | 按服务商定价 |

> OpenAI / Groq 等海外服务已从默认预设中移除，仍可通过「自定义」手动接入（Base URL + Key + 模型名）。

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
| 数据按设备隔离 | 模型缓存（190MB）、API Key、历史记录均存各自浏览器 |
| 免下载使用 | 在线模式 + 硅基流动免费 Key，开箱即用 |
| 企业内网 | 用自签/内部 CA 证书做 HTTPS（方案见 PROJECT_HANDOFF.md §6） |

## 技术栈

- Vite + React 18 + TypeScript + Tailwind CSS v4
- 本地引擎：[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) WASM（Apache-2.0），官方 streaming zipformer 中英双语 int8 模型
- 音频链路：AudioWorklet 采集 → 16kHz PCM → 流式识别 / WAV 分段上传
- 存储：localStorage（设置）+ IndexedDB（历史）+ Cache API（模型）

## 目录结构

```
├── public/sherpa/        # 本地引擎运行时（wasm + 官方封装层）
├── public/worklets/      # AudioWorklet 采集器
├── src/
│   ├── lib/
│   │   ├── audio/        # 采集、WAV 编解码、重采样、分段器
│   │   ├── asr/          # 本地引擎（sherpa-onnx）、在线客户端（OpenAI 兼容）
│   │   ├── models/       # 模型目录与下载缓存
│   │   └── store/        # 设置、历史
│   ├── pages/            # 实时转录 / 文件转写 / 历史 / 设置
│   └── components/       # Toast、波形等
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
