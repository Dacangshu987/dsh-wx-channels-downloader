# dsh-wx-channels-downloader

DSH 插件：微信视频号批量下载。在 DSH 网页界面（Web profile）内提供「视频号下载」控制台，流程完全按需求实现：

**打开插件 → 运行探测 → 提示重启微信 → 打开博主主页 → 自动探测视频列表 → 批量下载（解密 + 去重 + 按博主归档）**

- 不内置 nobiyou/wx_channel 完整程序；服务端（本地 MITM 代理、注入器、下载器、ISAAC64 解密、去重索引）为**自研 TypeScript 实现**，注入脚本与 JS 补丁参照其 MIT 源码移植（产物在 `assets/inject/`，出处见 `assets/ASSETS_README.md`）。
- 纯 Node 内置模块（`node:http/net/tls/sqlite`）实现 MITM，证书用 Windows PowerShell `New-SelfSignedCertificate` 生成并装入当前用户受信任根（免管理员）。零原生依赖。

## 安装（本地开发）

```bash
dsh plugin --profile web add link:D:/ds-harness-test/cz/wxdown/dsh-wx-channels-downloader
```

> 首次安装 / 更新后需要**重启 DSH profile** 才会加载服务端与客户端（`dsh-hmr` 只热更配置）。

## 使用流程

1. 在对话输入框工具箱点击 🎬 打开控制台（会话界面工具栏）。
2. 「运行探测」检查：微信安装/运行、CA 证书、系统代理、页面缓存。
3. 依序点：安装证书 → 设置系统代理 → 清理缓存 → 重启微信（插件会退出微信、清 `xwechat\radium\web\profiles` 缓存并重新拉起）。
4. 在 PC 微信打开任意博主主页 → 页面注入脚本自动翻页采集列表并回传 → 控制台实时列出（标题/作者/发布时间）。
5. 点「下载未下载」批量下载：服务端拉取媒体流 → ISAAC64 解密前 128KB → 按 `{作者}/{标题}_{档位}.mp4` 归档 → 以 `object_id` 去重。

## 架构

```
浏览器端 (lib/client.js)  🎬 按钮 + 全屏控制台（SSE 事件流）
        │  /wxchannels/state · /wxchannels/cmd · /wxchannels/events
服务端 (lib/index.js)  WxChannelsService
        ├─ MitmServer      127.0.0.1:2023 纯 Node MITM（仅 MITM channels.weixin.qq.com）
        │    ├─ 本地 API   /__wx_channels_api/*（profile/tip/save_video_list/download_video/batch_*）
        │    └─ 注入       HTML 页面注入脚本 + index.publish / virtual_svg-icons-register / worker_release 补丁
        ├─ Store           node:sqlite：video_catalog（博主全量列表） + download_records（去重）
        ├─ Downloader      fetch(带 Origin/Referer) → ISAAC64 解密 → 按作者归档 → object_id 去重
        ├─ Probe/WeChat    探测、证书、系统代理、清缓存、重启微信、weixin://dl/channels
        └─ Cert            PowerShell CA + 叶子证书（CurrentUser Root，免管理员）
```

## 验证

- `npm run typecheck` / `npm run build`（tsc 服务端 + esbuild 客户端）
- `npm test`：冒烟测试（`test/smoke.mjs`，20 项，覆盖本地 API 鉴权、MITM 隧道、注入补丁三种 bundle 形态与 ISAAC64 加解密）+ 下载器功能测试（`test/downloader-test.mjs`，7 项）
- `npm run test:decrypt`：`test/decrypt-equivalence.mjs`，ISAAC64 解密与 P0 实测验证过的 sphDecrypt 实现逐字节一致（含真实 key）。**注意**：该用例需要 `dist/main/main/services/sphDecrypt.js`（P0 参考实现产物），未提供时无法运行
- 冒烟测试需要 `openssl` 在 PATH 中（用于生成一次性自签证书；Git for Windows 自带 `C:\Program Files\Git\usr\bin\openssl.exe`）

## 风险与合规

- 依赖 PC 微信在线 + 系统代理；微信版本更新可能导致注入点失效（需按 `assets/inject` 与补丁模式更新）。
- 仅用于个人备份/留存；请遵守平台条款与版权，勿用于批量转载/去水印/破解付费内容。