# dsh-wx-channels-downloader

DSH 插件：微信视频号批量下载。在 DSH 网页界面（Web profile）内提供「视频号下载」控制台，流程完全按需求实现：

**打开插件 → 运行探测 → 提示重启微信 → 打开博主主页 → 自动探测视频列表 → 批量下载（解密 + 去重 + 按博主归档）**

- 不内置 nobiyou/wx_channel 完整程序；服务端（本地 MITM 代理、注入器、下载器、ISAAC64 解密、去重索引）为**自研 TypeScript 实现**，注入脚本与 JS 补丁参照其 MIT 源码移植（产物在 `assets/inject/`，出处见 `assets/ASSETS_README.md`）。
- 双拦截模式：
  - **B 进程注入模式（默认）**：自研 Go sidecar（`sidecar/`，基于 MIT 库 SunnyNet）对 `WeChatAppEx.exe` 做进程级拦截，可补丁 CDN bundle（`res.wx.qq.com`）→ 博主主页列表事件可靠触发。**需要管理员权限**（启动时 UAC 提权）。
  - **A 系统代理模式（兜底）**：纯 Node MITM（`node:http/net/tls/sqlite`）+ 页面内 XHR/fetch 钩子，证书用 PowerShell 生成装入当前用户受信任根（免管理员）。零原生依赖。
- 配置项 `processInjection`（默认 true）切换两种模式；`processInjection=false` 时回到系统代理 MITM + XHR 钩子。

## 安装（本地开发）

```bash
dsh plugin --profile web add link:D:/ds-harness-test/cz/wxdown/dsh-wx-channels-downloader
```

> 首次安装 / 更新后需要**重启 DSH profile** 才会加载服务端与客户端（`dsh-hmr` 只热更配置）。

## 使用流程

1. 在对话输入框工具箱点击 🎬 打开控制台（会话界面工具栏）。
2. 「设置」页：点「🧬 启动进程注入器（需管理员）」→ 非管理员会弹 UAC，允许后注入器运行（探测项「进程注入器 = 运行中」）。
3. 清缓存 → 重启微信（插件会退出微信、清 `xwechat\radium\web\profiles` 缓存并重新拉起）→ 打开视频号。
4. 在 PC 微信打开博主主页 → 页面脚本自动探测列表并回传（探测页实时显示全部，博主页按博主分组显示待下载）→ 点「批量下载 / 下载该博主全部」。
5. 下载：服务端拉取媒体流 → ISAAC64 解密前 128KB → 按 `{作者}/{标题}_{档位}.mp4` 归档 → 以 `object_id` 去重 → 视频库（仅已下载）可打开位置/删除。

## 架构

```
浏览器端 (lib/client.js)  🎬 按钮 + 六页签控制台（仪表盘/探测/博主/任务/视频库/设置，SSE 事件流）
        │  /wxchannels/state · /wxchannels/cmd · /wxchannels/events · /wxchannels/ingest
服务端 (lib/index.js)  WxChannelsService
        ├─ Sidecar (进程注入，默认)  sidecar/wxchannels-inject.exe（Go + SunnyNet）
        │    对 WeChatAppEx.exe 进程级 HTTPS 拦截（所有域名，含 CDN bundle）
        │    HTML 注入脚本 + JS bundle 补丁（finderUserPage/APILoaded/index.publish/worker_release）
        │    /__wx_channels_api/* → 中继到 /wxchannels/ingest 复用插件逻辑
        ├─ MitmServer (A 模式兜底)  127.0.0.1:2023 纯 Node MITM（仅 MITM channels.weixin.qq.com）
        │    HTML 注入 + 页面内 XHR/fetch 钩子抓取列表 JSON（不依赖 bundle 补丁）
        ├─ Store           node:sqlite：video_catalog（博主全量列表）+ download_records（去重）+ watched（关注清单）
        ├─ Downloader      fetch(带 Origin/Referer) → ISAAC64 解密 → 按作者归档 → object_id 去重
        ├─ Probe/WeChat    探测（含注入器状态）、证书、系统代理、清缓存、重启微信、weixin://dl/channels
        └─ Cert            PowerShell CA + 叶子证书（CurrentUser Root，免管理员）
```

## sidecar（进程注入器）构建

```bash
# 需要 Go 1.24+（便携版即可）与 mingw-w64 gcc（cgo）
# 首次：go mod tidy（GOPROXY 可用 goproxy.cn）
cd sidecar
CGO_ENABLED=1 CC=gcc go build -o wxchannels-inject.exe .
```

- 源码：`sidecar/main.go`（SunnyNet 进程代理 + 本地 API 中继）、`sidecar/patch.go`（HTML 注入 + JS bundle 补丁 + autoShim，`go:embed` 自带页面脚本）。
- SunnyNet 为 MIT 库，vendored 于工作区（`tools/nobiyou-src/pkg/sunnynet`），通过 `replace` 引用；**不包含 nobiyou 应用本体**。
- 注入状态写入 `%TEMP%\wxchannels-inject.status`，插件据此判断注入是否真正生效。

## 验证

- `npm run typecheck` / `npm run build`（tsc 服务端 + esbuild 客户端）
- `npm test`：冒烟测试（`test/smoke.mjs`，20 项，覆盖本地 API 鉴权、MITM 隧道、注入补丁三种 bundle 形态与 ISAAC64 加解密）+ 下载器功能测试（`test/downloader-test.mjs`，7 项）
- `npm run test:decrypt`：`test/decrypt-equivalence.mjs`，ISAAC64 解密与 P0 实测验证过的 sphDecrypt 实现逐字节一致（含真实 key）。**注意**：该用例需要 `dist/main/main/services/sphDecrypt.js`（P0 参考实现产物），未提供时无法运行
- 冒烟测试需要 `openssl` 在 PATH 中（用于生成一次性自签证书；Git for Windows 自带 `C:\Program Files\Git\usr\bin\openssl.exe`）

## 风险与合规

- 依赖 PC 微信在线 + 系统代理；微信版本更新可能导致注入点失效（需按 `assets/inject` 与补丁模式更新）。
- 仅用于个人备份/留存；请遵守平台条款与版权，勿用于批量转载/去水印/破解付费内容。