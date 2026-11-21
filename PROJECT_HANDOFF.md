# VoiceTrans · 项目交接文档

> 本文档面向后续接手维护/开发的工程师。产品介绍见 [README.md](./README.md)。
> 最后更新：2026-11-21 · 版本 v0.1.0

## 1. 项目概况

**一句话**：纯前端网页应用，提供实时语音转录与录音文件转文字，双引擎（浏览器本地 sherpa-onnx WASM / 用户自带 Key 的 OpenAI 兼容在线 API），无后端、无服务器。

| 项 | 值 |
|---|---|
| 仓库（GitHub） | https://github.com/Tresordie/voice_transcription.git |
| 仓库（Gitee） | https://gitee.com/simonyuan2019/voice_transcription.git |
| Git 远程配置 | 单一远程 `origin`，**双 push URL**（GitHub + Gitee），`git push origin master` 一次同步两端 |
| 分支 | `master` |
| 当前版本 | v0.1.0（初始提交 060015b + 文档提交） |
| 环境要求 | Node.js ≥ 18（开发机 Node v24 验证通过）；构建/运行任意主流 OS |
| 许可 | MIT（本项目代码）；`public/sherpa/` 内为 sherpa-onnx（Apache-2.0）官方构建产物 |

## 2. 技术栈

- Vite 6 + React 18 + TypeScript 5.8（strict）+ Tailwind CSS v4（`@tailwindcss/vite` 插件）
- UI 图标：lucide-react（唯一 UI 运行时依赖）
- 本地 ASR：sherpa-onnx 官方 WASM 构建（streaming zipformer 中英双语 int8）
- 音频链路：getUserMedia → AudioWorklet（16kHz PCM16 + RMS 电平）→ 流式识别 / WAV 分段
- 存储：localStorage（设置）· IndexedDB（历史）· Cache API（模型缓存）

## 3. 目录与关键文件职责

```
public/sherpa/                     # 本地引擎运行时（vendored，勿改动）
├── sherpa-onnx-wasm-main-asr.js   #   emscripten glue（非模块化，读全局 Module）
├── sherpa-onnx-wasm-main-asr.wasm #   WASM 主体 11.5MB
└── sherpa-onnx-asr.js             #   官方 JS 封装层 + 我方 epilogue（挂 window.SherpaOnnxASR）
public/worklets/pcm-collector.js   # AudioWorklet：采集 Float32 块发给主线程
src/lib/audio/wav.ts               # float/int16 转换、降采样、WAV 编码、decodeToPcm16k（OfflineAudioContext 重采样）
src/lib/audio/capture.ts           # MicRecorder：麦克风采集 + 电平 + MediaRecorder 录制 webm
src/lib/audio/segmenter.ts         # LiveSegmenter：在线实时模式的 4s 固定分段器
src/lib/asr/local.ts               # 本地引擎：ensureLocalEngine 单例、LocalStreamSession、transcribePcmLocal、状态订阅 hook
src/lib/asr/online.ts              # 在线客户端：PROVIDERS 预设、transcribeBlob、transcribeFile（60s 分段）、testOnline
src/lib/models/catalog.ts          # 本地模型目录（.data 地址、字节数）
src/lib/models/downloader.ts       # 下载器：Cache API 缓存、进度回调、多地址回落、取消
src/lib/store/settings.tsx         # 设置 Context + localStorage（键 vt:settings）
src/lib/store/history.ts           # IndexedDB（库 vt-db / 表 history）
src/pages/                         # LivePage / FilePage / SettingsPage / HistoryPage
proxy.mjs                          # 可选 CORS 透明代理（npm run proxy，端口 8787，路径 /proxy/<目标URL>）
```

## 4. 关键技术决策（为什么这样做）

### 4.1 本地引擎选型与集成方式（最重要的背景）
- 官方 GitHub Releases 的所有浏览器 WASM 产物都是**按 demo 预打包**：模型烧死在 `.data` 里、`EXPORTED_RUNTIME_METHODS` 不含 FS → 无法运行时换模型。
- 官方 `wasm/web` 模块化构建（支持运行时 FS 写模型）**没有现成产物**，需自建 emsdk 编译链（未采用）。
- **最终方案**：采用 HF Space `echoyzd/web-assembly-asr-sherpa-onnx-zh-en` 的构建（glue+wasm 内置仓库），190MB 的 `.data` 运行时从 hf-mirror（国内直连优先，huggingface.co 回落）下载 → Cache API 缓存 → **blob URL 通过 `Module.locateFile` 注入**（emscripten preloader 的 XHR 支持 `blob:` 地址）。该模式已被生产项目 Sokuji 验证。
- 识别器配置使用官方默认（transducer 路径 `./encoder.onnx` 等），与 `.data` 内打包文件名一致，`createOnlineRecognizer(Module)` 零配置可用。

### 4.2 wrapper 与 wasm 必须同源配对（ABI 陷阱）
`sherpa-onnx-asr.js` 封装层按 C 结构体逐字段写内存，字段随版本演进（master 已比 Space 版多出 qwen3Asr/cohereTranscribe 等）。**用了不同版本的 wrapper 会导致结构体错位**。当前三件套来自同一 Space，保持配对；升级时必须整体替换。

### 4.3 在线模式统一 OpenAI 兼容协议
所有服务商走 `POST {baseURL}/audio/transcriptions`。文件转写统一先解码 → 16kHz → 按 60s 切 WAV 顺序上传拼接：顺带把 m4a/webm 等格式归一化，规避各服务商的格式与 25MB 限制。

### 4.4 实时转录的两种实现
- 本地：真·流式（`acceptWaveform` + endpoint 检测定句）。
- 在线：4s 固定分段 + 尾段 flush，近实时。**已知取舍**：分段边界可能切断词语。

## 5. 验证状态（截至 v0.1.0）

**已验证（浏览器自动化实测）**
- `tsc --noEmit` 严格模式 + `vite build` 通过
- 四个页面渲染、深浅色主题、设置持久化（刷新后保留）、服务商预设联动
- 错误路径：麦克风拒绝提示、在线测试连接的 CORS/401 友好提示
- **硅基流动浏览器直连可达**（假 Key 返回真实 401 → CORS 通畅，默认开箱路径无障碍）

**待人工验收**
- 真实麦克风下的本地流式识别准确率与延迟
- 真实 API Key 的完整转写流程（含长音频分段）
- Safari / Firefox 兼容性（目前以 Chrome/Edge 为准）

## 6. 已知限制与坑

1. **安全上下文限制**：非 `https://`/`localhost` 页面，浏览器禁用麦克风与 Cache API（实时转录不可用；模型缓存会失效）。内网 HTTP 部署的对策见 README「部署与分发」。
2. **每设备数据隔离**：模型缓存（190MB）、API Key、历史记录都在各自浏览器里，换机器需重新下载/填写。
3. **Groq/OpenAI 可能被 CORS 拦**：浏览器直连被拦时提示用户跑 `npm run proxy` 或换硅基流动。
4. **本地 SenseVoice 延后**：官方无浏览器构建，需自建 wasm/web 运行时（emsdk 编译）。文件高精度场景目前走在线免费 SenseVoiceSmall。
5. **模型加载瞬时内存高**：blob + XHR 缓冲 + WASM 堆约 3 份副本（~600MB 峰值），低端设备注意。
6. **在线实时分段边界**可能切断词语（4s 固定窗口，无重叠）。
7. **本地模型英文输出为全大写**：streaming zipformer 的英文 BPE 词表本身全大写。已在 `src/lib/asr/case.ts` 做输出规整（检测到 >80% 单词全大写时转句子式大小写；正常文本/中文不受影响）。规整无法恢复标点与撇号（"IVE"→"ive" 而非 "I've"），需要标点的英文场景建议用在线引擎。

## 7. 常见维护操作

| 任务 | 做法 |
|---|---|
| 新增在线服务商 | 改 `src/lib/asr/online.ts` 的 `PROVIDERS` |
| 更换本地模型 | 改 `src/lib/models/catalog.ts`；**必须确认 `.data` 内文件名与识别器配置一致**（新模型需核对 Space 构建 的 assets 命名） |
| 升级 sherpa 运行时 | 从同一构建源重新下载 glue/wasm/wrapper 三件套整体替换；epilogue 追加段保留 |
| 发布 | `npm run build` → `dist/` 静态托管（必须 HTTPS 或 localhost；GitHub Pages 子路径需在 `vite.config.ts` 加 `base`） |
| 出桌面安装包 | Roadmap 项：加 Electron + electron-builder（Win 包本机可出，Mac 包需 Mac 构建），模型可打进安装包实现真离线 |

## 8. Roadmap

- [ ] 本地高精度文件模型（SenseVoice，需 emsdk 自建 wasm/web 运行时）
- [ ] SRT 字幕导出
- [ ] 说话人分离（VAD + diarization）
- [ ] 热词增强
- [ ] Electron 桌面打包（双击运行，麦克风免配置，模型可选内置）

## 9. 联系与归属

- 仓库所有者：simonyuan2019（Gitee）/ Tresordie（GitHub）
- 交接疑问优先查阅本文档 §4 的决策背景，再查 sherpa-onnx 官方文档：https://k2-fsa.github.io/sherpa/onnx/
