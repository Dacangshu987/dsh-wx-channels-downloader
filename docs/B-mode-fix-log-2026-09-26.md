# B 模式（进程级注入）修复日志

日期：2026-09-26
范围：`dsh-wx-channels-downloader` 的 sidecar 进程级拦截方案（SunnyNet）

## 背景

B 模式（Go sidecar + SunnyNet 对 `WeChatAppEx.exe` 进程级 HTTPS 拦截）从上游引入后一直无法工作：页面注入为空、自动探测拿不到视频列表（"暂无视频数据"）。本文档记录完整排查与修复过程。

---

## 排查结论

启动失败最初报错在 PowerShell CA 证书生成（`New-SelfSignedCertificate` 的 `{text}CA=TRUE&pathlen=1` 不被 Windows 接受，`0x80070057`）。修复后进一步出现大量编译错误与运行期失效，逐层定位到 10 个独立问题：

### 1. CA 证书扩展格式错误（插件启动崩溃）
- `src/core/cert.ts`：使用 `2.5.29.19={critical}{text}CA=TRUE&pathlen=1`。
- 修复：改为 ASN.1 十六进制编码 `2.5.29.19={critical}{hex}30060101FF020101`（= CA=TRUE, pathlen=1）。

### 2. SunnyNet 版本不匹配（编译失败）
- sidecar 的 `go.mod` 通过 `replace` 指向 `tools/nobiyou-src/pkg/sunnynet`，该路径必须是 **nobiyou 自带 vendored 的 SunnyNet v1.0.3**，而不是 GitHub main 分支的最新版。
- 用错版本导致：`SunnyNet/public` 包不存在、`HttpConn` API 名称变化、`StartProcess()` 缺失。
- 修复：clone 完整 nobiyou 仓库，把其 `pkg/sunnynet`（v1.0.3）放到 replace 目标路径。之后 Go 代码**零修改**即可编译（体积从 40.7MB 降到 9.4MB）。

### 3. MinGW 头文件冲突（cgo 编译失败）
- SunnyNet 的 `src/iphlpapi/c_iphlpapi_tcp.h` 重定义了 MinGW-w64 已提供的 `MIB_TCPROW2` / `MIB_TCPTABLE2` / `GetTcpTable2`。
- 修复：加 `#ifndef __MINGW32__` 条件编译 + 统一使用 `MIB_GETTCPTABLE2` 类型名（见头文件与 `.c` 文件）。
- 前提：安装 Go 1.27.1 与 mingw-w64（WinLibs，经 gh-proxy 镜像下载，GitHub 直连超时）。

### 4. `relayToPlugin` 前缀比较 bug（数据被静默丢弃）
- `sidecar/main.go` 原代码：`if len(path) < 16 || path[:16] != "/__wx_channels_api/"`。
- 前缀字面量 `"/__wx_channels_api/"` 是 **19 字节**，而 `path[:16]` 只有 16 字节，**永远不可能相等** —— 每个本地 API 调用都被放行给微信服务器，采集数据在最末端静默丢失。
- 修复：改用 `strings.HasPrefix(path, "/__wx_channels_api/")`。

### 5. 事件总线 emit 错误（采集器收不到事件）
- 页面脚本（`profile.js` 等）监听 **`WXE`**（注入脚本创建的 mitt eventbus），而补丁注入代码 `var T=window.WXU||window.WXE; T.emit(...)` **优先选了 `WXU`**（微信原生对象），事件发到了无人监听的总线上。
- 修复：`emitJS` 改为 **同时向 WXE 与 WXU 双总线 emit**（各自 try 保护）；`APILoaded` 同样处理。

### 6. gzip 压缩响应未解压（注入未真正生效）★最关键
- 微信请求带 `Accept-Encoding: gzip`，SunnyNet 给到代码的是**压缩后的二进制**（页面 1507B 全是 gzip 魔数 `1f 8b`）。
- 在压缩数据里执行 `strings.Replace(html, "<head>", ...)` **永远找不到 `<head>`** —— 注入脚本从未进入页面，之前所有 "注入成功 (1507B)" 的日志都是假的（大小没变）。
- 修复：`rewriteResponse` 增加 `decodeBody`/`encodeBody`（gzip、deflate），解压处理后重新压缩回写；找不到 `<head>` 时明确告警。
- **效果**：页面注入从 1507B 变成 **255KB**（255555B, enc=gzip），注入真正生效（页面能读到视频标题，证明脚本链路是活的）。

### 7. `copy-assets` 跳过 sidecar 资源（`go:embed` 失败）
- `scripts/copy-assets.mjs` 在 vendored 源缺失时提前 `exit`，跳过同步 `sidecar/assets/inject`（`go:embed` 需要）。
- 修复：手动同步注入资源到 `sidecar/assets/inject`。

### 8. `writeStatus` 硬编码 `injected: true`（假报注入成功）
- sidecar 启动时无论驱动是否真的初始化，都写 `"injected": true`，插件 UI 显示"注入成功"但实际没生效。
- 修复：仅在所有前置检查通过后写 true；失败时写 false 并退出。

### 9. `nfapi.dll` 资源缺失（`go:embed` 编译失败）
- SunnyNet `Resource` 需要 `nfapi/dll/x64/nfapi.dll`（与 `win32`），仓库未收录。
- 修复：使用系统已释放的 `C:\Windows\SunnyFilter64.dll`（即 nfapi 库，含 `nf_registerDriver`/`nf_init` 导出）补到资源目录。

### 10. 微信 bundle API 改名（采集事件不触发）
- 微信改版后，博主主页列表不再走 `FinderUserPage` 接口，改用 `FetchFinderMemberFeedList` / `FinderUserPagePreview`。
- 修复：新增 `patchSingleExpr` 处理单表达式箭头函数体，对 `fetchFinderMemberFeedList` 与 `finderUserPagePreview` 注入 `UserFeedsLoaded` 事件。

### 11. 响应缓存导致补丁代码从未执行
- 微信对 CDN bundle 有 HTTP/内存缓存：我们补丁了 bundle 但页面加载的是**缓存的未补丁版本**（`[补丁] xxx 返回` 日志从未出现）。
- 发现 nobiyou 在 `handleConnectPublish` 中设置 `Cache-Control: no-cache, no-store, must-revalidate` 等响应头。
- 修复：对**所有补丁成功**的响应设置 no-cache 头（对齐 nobiyou 行为）。
- **效果**：补丁次数从 5-6 次升至 **30 次**（微信每次重新请求、加载补丁版）。

---

## 验证证据（节选）

- `ensureCa OK, trusted root installed: true`（CA 修复）
- `[wxinject] 进程注入成功: WeChatAppEx.exe`、`[wxinject] 驱动已就绪（NFAPI）`
- `注入页面 /web/pages/home (255555B, enc=gzip)`（gzip 修复后）
- `relay POST /__wx_channels_api/inject_health -> 200`（前缀 bug 修复后）
- 探针：`{"wxu":true,"wxe":true,"store":true,"format_feed":true,"collector":true,"isListPage":true,"events":25}`
- 补丁内容校验：`virtual_svg-icons-register` 含 `window.WXE.emit` / `UserFeedsLoaded`；`fetchFinderMemberFeedList` / `finderUserPagePreview` / `finderUserPage` 均已在补丁后代码中确认。
- 补丁频次：no-cache 后 30 次（微信持续重新拉取补丁版 bundle）。

---

## 当前状态与已知限制

- B 模式基础设施已全部打通（驱动、注入、补丁、中继）。
- 微信页面脚本能捕获到实时视频标题（`__wx_log` 输出），批量下载面板的数据链路待最终验证（微信 bundle 结构仍在演进，作者在 nobiyou 中也持续适配）。
- A 模式（系统代理 MITM + 页面 XHR/fetch 钩子）此前已成功下载过视频，作为保底方案可随时切回。