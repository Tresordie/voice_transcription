# VoiceTrans · 项目交接文档

> 本文档面向后续接手维护/开发的工程师。产品介绍见 [README.md](./README.md)。
> 最后更新：2026-11-23 · 版本 v0.1.x（以 package.json 为准）

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
src/lib/ai/templates.ts            # AI 总结预设模板（25 套，脚本生成——勿手改，见 scripts/extract-templates.mjs）
src/lib/ai/llm.ts                  # OpenAI 兼容 chat/completions 客户端（非流式 + SSE 流式解析）
src/lib/ai/summarize.ts            # 总结编排：>12k 字 map-reduce（分块提取要点→归并），模板作用于最终阶段，流式输出
src/lib/ai/extract.ts              # 附件提取（≤150MB/文件）：txt 直读、pdf/docx/xlsx/pptx 动态解析、音频走已有转写引擎
src/lib/ai/exporters.ts            # 六格式导出：md/html(内联排版)/pdf(打印引擎)/doc(Word 兼容 HTML)/xlsx(SheetJS)/pptx(pptxgenjs)，重依赖动态 import
src/lib/ai/wechat.ts               # markdown→微信纯文本（emoji 标题+【】+符号列表），供一键复制
src/lib/models/catalog.ts          # 本地模型目录：ZIPFORMER_ZH_EN（流式）+ SENSEVOICE_OFFLINE（离线）
src/lib/models/downloader.ts       # 下载器：Cache API 缓存、进度回调、多地址回落、取消
src/lib/store/settings.tsx         # 设置 Context + localStorage（键 vt:settings，含 ai: LLM 配置）
src/lib/store/history.ts           # IndexedDB（库 vt-db / 表 history）
src/pages/                         # LivePage / FilePage / AiPage / HistoryPage / SettingsPage
src/components/MarkdownView.tsx    # LLM 输出渲染（marked + DOMPurify，样式 .md-view）
proxy.mjs                          # 可选 CORS 透明代理（npm run proxy，端口 8787，路径 /proxy/<目标URL>）
vite.config.ts                     # dev 服务器 CORS 流式透传代理（/proxy/<目标URL>，支持 SSE 逐字转发，与 proxy.mjs 等价）
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

### 4.6 AI 总结页（2026-11-22 新增）
独立于语音识别的第二条 AI 链路：用户输入文本/附件（≤150MB/文件）→ 自定义 OpenAI 兼容大模型 → 结构化 Markdown 总结。
- **模板**：来自 `scenario-templates` 技能（外部目录 `~\.agents\skills\scenario-templates`）。`scripts/extract-templates.mjs` 从其 gallery HTML 内嵌 JSON 提取 25 套模板（id/scenario/name/desc/modules/prompt + 854 字共享输出契约 G-SPEC）生成 `src/lib/ai/templates.ts`。改模板数据源后重跑脚本即可同步。
- **总结编排**（summarize.ts）：全文 >12k 字启用 map-reduce——按段落分块（~8000 字/块）并发 2 提取要点 → 要点合集进入最终阶段；模板提示词（含 G-SPEC）只作用于最终阶段；map 上限 120 块（约 100 万字符），超出截断并在结果中注明。最终阶段流式（SSE 逐 delta），AiPage 以 ~150ms 节流渲染。
- **附件提取**（extract.ts）：txt/md/csv/json 代码类直读；pdf 走 pdfjs-dist（worker 以 `?url` 静态导入）；docx/pptx 用 JSZip 解包 XML 正则提取（**故意不用 mammoth**——其主入口依赖 node fs）；xlsx 用 SheetJS；音频复用 ASR 链路（在线 transcribeFile / 本地优先 SenseVoice 回落 Zipformer）。`.doc`（旧版）不支持，UI 提示另存为 .docx。
- **富渲染管线**（richRender.ts，预览/导出共用）：G-SPEC 契约会让模型输出 SVG 封面块与 mermaid 图（思维导图/流程图/甘特图），marked 只产出源码块——`renderRichMarkdown` 将 ```mermaid / ```svg 代码块升级为真实图形；代码块**内容特征优先**识别（以 `<svg` 开头→svg、以图类型关键字开头→mermaid，与围栏语言无关——模型常用 xml/html 围栏标注 SVG）。**模型手写 SVG 经 fitSvgText 修复**：canvas 逐行测量文本宽度，坐标计入祖先 `translate` 变换（模型常把内容包在 `<g transform="translate">` 里，漏算会整体错位漏判），可用宽度取「所在最小容器框」（rect 几何 / path 画圆角框用 getBBox 量，过滤下划线等非容器形状）与 viewBox 右缘的较小者；轻微超宽（≥0.75 倍）缩字号，**内容较多（<0.75 倍）按容器宽度自动换行成多行——框体不够高时增高 rect 并把下方内容整体下移让位**（用户实测长结论在框内被截断，换行才放得下）；带样式的 tspan 混排退回 textLength 压缩；缺 viewBox 时由 width/height 补齐；内容超高时 getBBox 扩展 viewBox。**mermaid 配置两处关键点**：顶层 `fontFamily` 与 `themeVariables.fontFamily` 必须一致（测量与渲染同字体，否则 CJK 混排测量偏窄→foreignObject 文字被节点框裁断）；gantt `useWidth: 1100` 把甘特图时间轴压缩到固定宽度（超宽甘特缩放后文字不可读）。**宽图处理**：renderRichMarkdown 末尾把固有宽度 >1100px 的图形标记 `.md-fig-wide`（显式像素 width + max-width:none）——预览/HTML 导出由 .md-figure overflow-x:auto 原尺寸横向滚动，打印 @media print 退回等比缩放（纸张不能滚动，完整优先），不缩放的等价物是光栅化分辨率跟随固有尺寸（svgTextToPng 的 normalizeSvgSize + canvas ≤3200px）。时间轴有两条升级路径：① 表格（表头时间列/mm:ss 特征，detectTimeline）；② **列表**（模型按 G-SPEC 输出的「彩点 emoji+日期」markdown 列表，parseTimelineListItems，≥60% 命中彩点/日期才升级防误伤）——两者都转为 timeline.ts 的规范时间轴卡片（竖线连线+阶段彩点+日期胶囊，emoji 直接映射语义色 蓝=推进/棕=停滞/红=升级）。mermaid 输出**不能用 DOMPurify 清洗**（会剥离 foreignObject 内 HTML，文字全丢），改用针对性净化（移除 script/事件属性/javascript: 链接）。flowchart 默认渲染器为 **ELK**（`@mermaid-js/layout-elk` 注册 + `defaultRenderer: 'elk'`，运行时支持但类型已移除需断言；注册失败回落 dagre）——正交边路由显著减少复杂图的斜线长边；CJK 长标签适配（wrappingWidth 280 + 显式 CJK fontFamily 修正文本测量）避免菱形文字溢出被裁。流式期间 MarkdownView 走轻量同步路径（图形保持源码），生成完成后自动升级。
- **导出**（exporters.ts）：**md 导出时图形一律栅格化为 PNG data URI 内嵌**（svg/mermaid 围栏 + 裸 `<svg>` HTML 块，时间轴列表内联时间轴卡片 HTML；转换失败回落内联 SVG/保留源码）——用户实测 Typora 等查看器剥离内联 SVG 的 `<style>`（rect 默认 fill=黑，全部黑块）且不渲染 foreignObject 文字，PNG 在所有主流查看器显示一致；html/doc 共用 marked+内联 CSS 模板；**pdf 走浏览器打印引擎**（window.open 打印窗口自动唤起打印，对话框内选「另存为 PDF」——html2canvas/html-to-image 两条 canvas 光栅化路线在本应用均不可靠：html2canvas 解析 Tailwind v4 的 oklch 颜色抛错且不渲染 foreignObject，离屏/负 z-index 定位又产出空白画布，详见 exporters.ts 注释）；doc 为 Word 兼容 HTML（Word/WPS 可开，内联 SVG 已转 PNG）；xlsx 用 SheetJS（概要表+每表格一工作表）；pptx 用 pptxgenjs（h1/h2 分页，svg/mermaid 转 PNG 插图，模型 SVG 先过 fitSvgText）。重依赖全部动态 import，均不进首屏 chunk。
- **微信格式**（wechat.ts）：微信聊天框不保留富文本，逐行转换 markdown → 纯文本（标题→emoji+【】、列表→•、表格→「列:值 ｜ 列:值」）。
- **LLM 配置**：`settings.ai`（独立于 ASR 的 baseURL/apiKey/model），设置页「AI 总结服务」区块含测试连接。
- **dev 代理流式化**：vite corsProxyPlugin 已从 `upstream.arrayBuffer()` 整体缓冲改为逐块 pipe（SSE 必须）；`proxy.mjs`（独立部署用）当前仍为整体缓冲——需要流式输出时须同步改造。

## 5. 验证状态（截至 v0.1.x）

**已验证（浏览器自动化实测）**
- `tsc --noEmit` 严格模式 + `vite build` 通过
- 四个页面渲染、深浅色主题、设置持久化（刷新后保留）、服务商预设联动
- 错误路径：麦克风拒绝提示、在线测试连接的 CORS/401 友好提示
- **硅基流动浏览器直连可达**（假 Key 返回真实 401 → CORS 通畅，默认开箱路径无障碍）

**已验证（2026-11-22 增补）**
- `tsc --noEmit` 严格模式 + `vite build` 通过（所有功能提交后均复验）
- **离线引擎 Node 端到端冒烟**：MODULARIZE glue 实例化 → FS 导出 → 228MB 模型注入 → SenseVoice 解码输出带标点中文（SAPI 合成语音验证，4.7s 音频 1.2s 解码）
- **离线引擎浏览器实测**：设置页下载 228MB（hf-mirror）→ Cache API → 引擎初始化「已就绪」→ 文件转写页真实转写成功（结果「今天下午3点开会，请带上季度报告。」）
- **AI 总结页浏览器冒烟**：导航/页面渲染、25 套模板与场景分组、txt 附件提取（DataTransfer 注入 → 「提取完成」）、未配置 AI 时的引导提示、设置页「AI 总结服务」区块（含测试连接按钮）；构建产物确认重依赖（pdf/xlsx/pptx/html2pdf）均为懒加载 chunk
- **富渲染实测**（richRender）：mermaid mindmap/甘特图、SVG 代码块全部升级为图形（svgBBox 实际绘制、中文文字保留、表格不受影响、净化后零脚本残留）；打印 HTML 在 iframe 实测渲染出 h1 与 mermaid 图形
- **切页状态保留实测**：AI 页文本与模板选中状态跨页保留
- 百炼 qwen3-asr-flash 探测链为预设默认路径；qwen-audio-3.0-asr-flash 专用协议（parameters.format + X-DashScope-SSE 头）已按官方 HTTP API 文档适配，噪声拒识（HAVE_NO_WORDS）按成功处理

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
