# VoiceTrans · 项目交接文档

> 本文档面向后续接手维护/开发的工程师。产品介绍见 [README.md](./README.md)。
> 最后更新：2026-11-22 · 版本 v0.1.x（以 package.json 为准）

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
public/sherpa/                     # 流式引擎运行时（vendored，勿改动）
public/sherpa/offline/             # 离线高精度引擎运行时（自建 vad-asr 构建，MODULARIZE+FS；见 §4.4）
├── sherpa-onnx-wasm-main-asr.js   #   emscripten glue（非模块化，读全局 Module）
├── sherpa-onnx-wasm-main-asr.wasm #   WASM 主体 11.5MB
└── sherpa-onnx-asr.js             #   官方 JS 封装层 + 我方 epilogue（挂 window.SherpaOnnxASR）
public/worklets/pcm-collector.js   # AudioWorklet：采集 Float32 块发给主线程
src/lib/audio/wav.ts               # float/int16 转换、降采样、WAV 编码、decodeToPcm16k（OfflineAudioContext 重采样）
src/lib/audio/capture.ts           # MicRecorder：麦克风采集 + 电平 + MediaRecorder 录制 webm
src/lib/audio/segmenter.ts         # LiveSegmenter：在线实时模式的 4s 固定分段器
src/lib/asr/local.ts               # 本地流式引擎：ensureLocalEngine 单例、LocalStreamSession、transcribePcmLocal、状态订阅 hook
src/lib/asr/offline.ts             # 本地离线高精度引擎（SenseVoice 非流式）：ensureOfflineEngine、transcribePcmOffline、FS 注入模型
src/lib/asr/online.ts              # 在线客户端：PROVIDERS 预设、transcribeBlob（含百炼 6 形态协议探测链）、transcribeFile（60s 分段）、testOnline
src/lib/models/catalog.ts          # 本地模型目录：ZIPFORMER_ZH_EN（流式）+ SENSEVOICE_OFFLINE（离线）
src/lib/models/downloader.ts       # 下载器：Cache API 缓存、进度回调、多地址回落、取消
src/lib/store/settings.tsx         # 设置 Context + localStorage（键 vt:settings）
src/lib/store/history.ts           # IndexedDB（库 vt-db / 表 history）
src/pages/                         # LivePage / FilePage / SettingsPage / HistoryPage
proxy.mjs                          # 可选 CORS 透明代理（npm run proxy，端口 8787，路径 /proxy/<目标URL>）
vite.config.ts                     # dev 服务器内置同款代理（/proxy/<目标URL>），与 proxy.mjs 等价
```

## 4. 关键技术决策（为什么这样做）

### 4.1 本地引擎选型与集成方式（最重要的背景）
- 官方 GitHub Releases 的所有浏览器 WASM 产物都是**按 demo 预打包**：模型烧死在 `.data` 里、`EXPORTED_RUNTIME_METHODS` 不含 FS → 无法运行时换模型。
- 官方 `wasm/web` 模块化构建（支持运行时 FS 写模型）**没有现成产物**，需自建 emsdk 编译链（未采用）。
- **最终方案**：采用 HF Space `echoyzd/web-assembly-asr-sherpa-onnx-zh-en` 的构建（glue+wasm 内置仓库），190MB 的 `.data` 运行时从 hf-mirror（国内直连优先，huggingface.co 回落）下载 → Cache API 缓存 → **blob URL 通过 `Module.locateFile` 注入**（emscripten preloader 的 XHR 支持 `blob:` 地址）。该模式已被生产项目 Sokuji 验证。
- 识别器配置使用官方默认（transducer 路径 `./encoder.onnx` 等），与 `.data` 内打包文件名一致，`createOnlineRecognizer(Module)` 零配置可用。

### 4.2 wrapper 与 wasm 必须同源配对（ABI 陷阱）
`sherpa-onnx-asr.js` 封装层按 C 结构体逐字段写内存，字段随版本演进（master 已比 Space 版多出 qwen3Asr/cohereTranscribe 等）。**用了不同版本的 wrapper 会导致结构体错位**。当前三件套来自同一 Space，保持配对；升级时必须整体替换。

### 4.3 在线模式：OpenAI 兼容协议为主，Qwen-ASR 走独立协议
主要服务商走 `POST {baseURL}/audio/transcriptions`（multipart）。文件转写统一先解码 → 16kHz → 按 60s 切 WAV 顺序上传拼接：顺带把 m4a/webm 等格式归一化，规避各服务商的格式与 25MB 限制。
**例外**：阿里百炼 Qwen-ASR（qwen3-asr-flash / qwen-audio-3.0-asr-flash 等）的 OpenAI 兼容模式走 `chat/completions` + `input_audio`（Base64 Data URI），实现于 `online.ts` 的 `transcribeQwenChat`（transport: 'qwen-chat'），复用同一分段机制。百炼域名未开放 CORS，浏览器直连必被拦，须走 dev 内置代理（vite.config.ts 的 `/proxy/<target>` 中间件）或 `proxy.mjs`。

2026-11-21 更新：**阿里百炼已从默认预设移除**（用户的 Token 计划端点 `token-plan.cn-beijing.maas.aliyuncs.com` 对 chat/completions + input_audio 全部字段形态返回空体 400、对 /audio/transcriptions 返回 404 Api not found，推断该模型未开通或不支持兼容模式协议）。协议按域名自动识别（dashscope/maas.aliyuncs.com → qwen-chat）与代理能力保留在代码中，自定义接入百炼时仍可用。若后续拿到该模型的控制台调用示例，可据此精确适配后再恢复预设。

2026-11-21 补充：qwen-chat 适配器已升级为**协议形态自动探测**——依次尝试 chat/completions + input_audio 的 4 种字段形态（Data URI / 裸 Base64 × 带/不带 format）→ multipart /audio/transcriptions → DashScope 原生 multimodal-generation（compatible-mode 同域不同路径），成功即用；仅 400（参数体校验）才继续换形态，401/404/5xx 直接停止。全失败时聚合各形态的服务端响应与 request-id 辅助定位。vite dev 服务器内置了 `/proxy` 透传中间件（与 proxy.mjs 等价），设置页提供「改用内置代理」一键把裸百炼地址包成 `http://localhost:5173/proxy/<...>`。
**实测坑**：百炼实时模型（`fun-asr-realtime` 等 `-realtime` 后缀）只支持 WebSocket 流式协议，对全部 6 种 HTTP 形态必然失败——兼容模式 404 Unsupported model、multipart CORS 拦截、原生端点 400 UNSUPPORTED_FORMAT。HTTP 转写请用 Qwen-ASR 家族（推荐 `qwen3-asr-flash`）。非实时 `fun-asr` 走 DashScope 原生异步文件转写（提交任务 + 轮询），本应用同样未实现。

2026-11-22 更新：**已恢复「阿里百炼」预设**（qwen3-asr-flash，dashscope 域名自动识别 qwen-chat 协议），并新增**热词/上下文**支持——`transcribeQwenChat` 的 chat/completions（形态 1-4）与原生端点（形态 6）在热词非空时前置 system message（官方约定：system 仅用于识别上下文），标准 transcriptions 协议则追加 multipart `prompt` 字段。注意：订阅制 Token Plan 端点（token-plan.cn-beijing.maas.aliyuncs.com）官方禁止自动化 API 调用且不提供裸音频 HTTP 接口，不能用于本应用。官方推荐新端点为业务空间专属域名 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，经典 dashscope 域名仍可用。

### 4.4 本地离线高精度引擎（SenseVoice，2026-11-22 新增）
文件转写页在 SenseVoice 模型已缓存时自动切换离线引擎，否则回落流式 zipformer；实时转录页始终用 zipformer（SenseVoice 非流式，无逐字体验）。
- **构建来源**：无官方预编译产物（v2.0.2 release 只剩 TTS/VAD；asr-models tag 无 wasm），故本地自建。工具链：emsdk 4.0.23 + ninja + cmake 4.5.1（emsdk 不捆绑 cmake/ninja，需自备）。源码 master `8a667ab1`，依赖（kaldi-native-fbank v1.23.1、onnxruntime-wasm simd 1.28.2 等）由 cmake FetchContent 从 GitHub 拉取。
- **CMake 定制**（相对官方 `wasm/vad-asr/CMakeLists.txt` 三处）：① 移除 silero_vad 强制检查与内置（文件转写固定分块，不用 VAD），.data 仅内置 tokens.txt（317KB）；② `-s MODULARIZE=1 -s EXPORT_NAME=SherpaOnnxVadAsrModule`（独立 factory，与流式引擎的全局 Module 互不冲突）；③ EXPORTED_RUNTIME_METHODS 增加 `'FS'`（运行时注入模型）。
- **模型分发**：SenseVoice int8（model.int8.onnx 239,233,841 字节）不入库（GitHub 100MB 限制），运行时从 HF 镜像 `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` 下载 → Cache API 缓存 → `Module.FS.writeFile('/sense-voice.onnx', bytes)` 注入 MEMFS。运行时四件套（glue/wasm 13.1MB/.data/wrapper）vendor 在 `public/sherpa/offline/`。
- **wrapper 隔离**：离线 wrapper 是官方 `wasm/asr/sherpa-onnx-asr.js` 的 IIFE 隔离副本，暴露 `window.SherpaOnnxOfflineNS`，与流式引擎（echoyzd 旧版）wrapper 的全局类声明互不覆盖。两套 wrapper 必须各自与同源构建配对（§4.2 ABI 陷阱）。
- **构建可复现命令**（PowerShell/Git Bash，构建目录 `F:/sherpa-wasm-build/`）：
  ```
  source emsdk/emsdk_env.sh
  cd sherpa-onnx && mkdir build-wasm-simd-vad-asr && cd $_
  cmake -G Ninja -DCMAKE_TOOLCHAIN_FILE=$EMSCRIPTEN/cmake/Modules/Platform/Emscripten.cmake \
    -DSHERPA_ONNX_ENABLE_WASM_VAD_ASR=ON -DSHERPA_ONNX_ENABLE_WASM=ON -DBUILD_SHARED_LIBS=OFF \
    -DSHERPA_ONNX_ENABLE_BINARY=OFF -DSHERPA_ONNX_ENABLE_PYTHON=OFF ... ..   # 完整参数见 build-wasm-simd-vad-asr.sh
  cmake --build . --parallel 8 && cmake --install .
  node vendor.mjs   # 拷贝 glue/wasm/.data + wrapper IIFE 化 → public/sherpa/offline/
  node test-offline.cjs  # Node 端到端冒烟（真实模型解码）
  ```
- **已知取舍**：① 30s 分块解码（SenseVoice 设计时长为短音频，过长影响标点质量），每块解码阻塞主线程 1-3s；② FS.writeFile 一次性写 228MB，JS 堆 + WASM 堆瞬时双份（INITIAL_MEMORY 512MB + 允许增长）；③ 引擎状态随页面刷新重置，模型缓存（Cache API）持久。

### 4.5 实时转录的两种实现
- 本地：真·流式（`acceptWaveform` + endpoint 检测定句）。
- 在线：4s 固定分段 + 尾段 flush，近实时。**已知取舍**：分段边界可能切断词语。

## 5. 验证状态（截至 v0.1.0）

**已验证（浏览器自动化实测）**
- `tsc --noEmit` 严格模式 + `vite build` 通过
- 四个页面渲染、深浅色主题、设置持久化（刷新后保留）、服务商预设联动
- 错误路径：麦克风拒绝提示、在线测试连接的 CORS/401 友好提示
- **硅基流动浏览器直连可达**（假 Key 返回真实 401 → CORS 通畅，默认开箱路径无障碍）

**已验证（2026-11-22 增补）**
- `tsc --noEmit` 严格模式 + `vite build` 通过（O2+O3 与 L3 两次提交后均复验）
- **离线引擎 Node 端到端冒烟**：MODULARIZE glue 实例化 → FS 导出 → 228MB 模型注入 → SenseVoice 解码输出带标点中文（SAPI 合成语音验证，4.7s 音频 1.2s 解码）
- **离线引擎浏览器实测**：设置页下载 228MB（hf-mirror）→ Cache API → 引擎初始化「已就绪」→ 文件转写页真实转写成功（结果「今天下午3点开会，请带上季度报告。」）
- 百炼 qwen3-asr-flash 探测链为预设默认路径；qwen3-asr-flash 真实 Key 的成功转写仍待人工验收

**待人工验收**
- 真实麦克风下的本地流式识别准确率与延迟
- 真实 API Key 的完整转写流程（含长音频分段）
- Safari / Firefox 兼容性（目前以 Chrome/Edge 为准）
- 百炼 qwen-chat 探测链的成功路径（`qwen3-asr-flash` + 真实 Key 完整转写）尚未实测；错误聚合路径已在 fun-asr-realtime 误配场景实测（2026-11-21）
- 离线引擎长音频（>5 分钟）分段转写的耗时与内存表现；低端设备上 228MB 模型注入的内存峰值

## 6. 已知限制与坑

1. **安全上下文限制**：非 `https://`/`localhost` 页面，浏览器禁用麦克风与 Cache API（实时转录不可用；模型缓存会失效）。内网 HTTP 部署的对策见 README「部署与分发」。
2. **每设备数据隔离**：模型缓存（190MB）、API Key、历史记录都在各自浏览器里，换机器需重新下载/填写。
3. **Groq/OpenAI 可能被 CORS 拦**：浏览器直连被拦时提示用户跑 `npm run proxy` 或换硅基流动。
4. **本地 SenseVoice 延后**：官方无浏览器构建，需自建 wasm/web 运行时（emsdk 编译）。文件高精度场景目前走在线免费 SenseVoiceSmall。
5. **模型加载瞬时内存高**：blob + XHR 缓冲 + WASM 堆约 3 份副本（~600MB 峰值），低端设备注意。
6. **在线实时分段边界**可能切断词语（4s 固定窗口，无重叠）。
7. **本地模型英文输出为全大写**：streaming zipformer 的英文 BPE 词表本身全大写。已在 `src/lib/asr/case.ts` 做输出规整（检测到 >80% 单词全大写时转句子式大小写；正常文本/中文不受影响）。规整无法恢复标点与撇号（"IVE"→"ive" 而非 "I've"），需要标点的英文场景建议用在线引擎。
8. **百炼实时模型不可经 HTTP 调用**：`fun-asr-realtime` 等 `-realtime` 后缀模型仅支持 WebSocket 实时协议，HTTP 探测链全失败（见 §4.3）。自定义接入时模型名用 `qwen3-asr-flash`；UI 侧无模型白名单，只能靠错误信息中的「Unsupported model」与 request-id 定位。

## 7. 常见维护操作

| 任务 | 做法 |
|---|---|
| 新增在线服务商 | 改 `src/lib/asr/online.ts` 的 `PROVIDERS` |
| 更换本地模型 | 改 `src/lib/models/catalog.ts`；**必须确认 `.data` 内文件名与识别器配置一致**（新模型需核对 Space 构建 的 assets 命名） |
| 升级离线引擎（SenseVoice）wasm | 按 §4.4 重新自建：emsdk + sherpa-onnx master → vad-asr CMake 定制 → vendor 脚本拷入 `public/sherpa/offline/`，wrapper 与 wasm 必须同源配对 |
| 热词字段 | `AppSettings.hotwords`（localStorage `vt:settings`）；Qwen-ASR 走 system message，transcriptions 走 prompt 字段（`src/lib/asr/online.ts`） |
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
