/**
 * WxChannelsService: wires Store + Downloader + Injector + MitmServer +
 * probe/wechat helpers into one lifecycle the plugin apply() drives.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { ensureCa, ensureLeaf } from './cert.js';
import { Downloader } from './downloader.js';
import { Hub } from './events.js';
import { Injector } from './inject.js';
import { handleLocalApi } from './localApi.js';
import { MitmServer } from './proxy.js';
import { runProbe, setSystemProxy } from './probe.js';
import { Store } from './store.js';
import { clearCache, isWechatRunning, launchWechat, stopWechat } from './wechat.js';
import { defaultDownloadsDir, recordsDbPath } from './paths.js';
const CHANNELS_HOST = 'channels.weixin.qq.com';
const SIDECAR_PORT = 2026;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url)) + '/../..';
export class WxChannelsService {
    cfg;
    hub = new Hub();
    store;
    downloader;
    injector = new Injector((msg) => this.hub.emitLog(msg));
    proxy = null;
    downloadsDir;
    lastProbe = null;
    /** Whether WE turned the system proxy on (and therefore should restore it on stop). */
    proxyEnabledByUs = false;
    currentUrl = '';
    constructor(cfg) {
        this.cfg = cfg;
        this.downloadsDir = cfg.downloadsDir && cfg.downloadsDir.trim() !== '' ? cfg.downloadsDir : defaultDownloadsDir();
        mkdirSync(this.downloadsDir, { recursive: true });
        this.store = new Store(recordsDbPath());
        this.downloader = new Downloader(this.store, this.downloadsDir, cfg.maxConcurrent, this.hub);
    }
    get isStarted() {
        return this.proxy !== null;
    }
    async start() {
        if (process.platform !== 'win32') {
            this.hub.emitLog('⚠️ 本插件仅支持 Windows（依赖 PC 微信 + 系统代理 + Windows 证书存储）');
            return;
        }
        if (this.cfg.processInjection) {
            this.hub.emitLog('🧬 进程注入模式：跳过系统代理 MITM，启动 sidecar 注入器');
            await this.spawnSidecar();
            this.hub.emitLog('▶ 打开 PC 微信，进入任一博主主页，即可自动探测视频列表');
            await this.refreshProbe(true);
            return;
        }
        await ensureCa();
        const leaf = await ensureLeaf(CHANNELS_HOST);
        this.proxy = new MitmServer(this.cfg.port, new Set([CHANNELS_HOST]), leaf, {
            isLocalApiPath: (pathname) => pathname.startsWith('/__wx_channels_api/'),
            handleLocalApi: (req, res) => handleLocalApi(this.localApiContext(), req, res),
            interceptResponse: (host, pathname, contentType, body) => this.interceptResponse(host, pathname, contentType, body),
            onInterceptSkip: (pathname, declared) => this.hub.emitLog(`⚠️ ${pathname} 响应过大（${Math.round(declared / 1024)}KB），未注入补丁直接透传`),
        });
        await this.proxy.start();
        if (this.cfg.autoSetProxy) {
            const r = await setSystemProxy(this.cfg.port, true);
            if (!r.ok)
                this.hub.emitLog(`⚠️ 设置系统代理失败: ${r.error}`);
            else
                this.proxyEnabledByUs = true;
        }
        this.hub.emitLog(`✅ 代理已启动: 127.0.0.1:${this.cfg.port}（微信视频号流量经此注入）`);
        this.hub.emitLog('▶ 打开 PC 微信，进入任一博主主页，即可自动探测视频列表');
        await this.refreshProbe(true);
    }
    async stop() {
        if (this.proxy) {
            await this.proxy.stop();
            this.proxy = null;
        }
        if (this.proxyEnabledByUs) {
            await setSystemProxy(this.cfg.port, false);
            this.proxyEnabledByUs = false;
        }
        this.store.close();
    }
    async refreshProbe(emit = false) {
        const out = await runProbe({
            port: this.cfg.port,
            downloadsDir: () => this.downloadsDir,
            recordsCount: () => this.store.listDownloads().length,
            sidecarPort: this.cfg.processInjection ? SIDECAR_PORT : undefined,
        });
        this.lastProbe = out.result;
        if (emit)
            this.hub.emitProbe(out.result);
        return out.result;
    }
    localApiContext() {
        return {
            store: this.store,
            downloader: this.downloader,
            hub: this.hub,
            token: () => this.cfg.secretToken,
            autoDownload: () => this.cfg.autoDownload,
            shouldCapture: (username) => this.shouldCapture(username),
            saveCoverUrl: (coverUrl, videoId, title, author) => this.saveCoverUrl(coverUrl, videoId, title, author),
        };
    }
    /** HTML/JS rewrite seam used by the proxy. */
    interceptResponse(host, pathname, contentType, body) {
        const ct = contentType.toLowerCase();
        try {
            if (host === CHANNELS_HOST && ct.includes('text/html')) {
                const html = body.toString('utf8');
                const rewritten = this.injector.rewriteHtml(host, pathname, html, { token: this.cfg.secretToken, version: 'v0.1.0' });
                if (rewritten !== null) {
                    this.hub.emitLog(`📄 已注入页面: ${pathname}`);
                    return Buffer.from(rewritten, 'utf8');
                }
                return null;
            }
            if (ct.includes('javascript') || ct.includes('ecmascript')) {
                this.hub.emitLog(`🩹 JS 响应经代理: ${pathname} (${body.length}B)`);
                const { content, handled } = this.injector.patchJavaScript(pathname, body.toString('utf8'));
                if (handled) {
                    this.hub.emitLog(`🩹 已补丁 JS: ${pathname.includes('virtual') ? 'virtual_svg-icons-register' : pathname.split('/').pop()}`);
                    return Buffer.from(content, 'utf8');
                }
                return null;
            }
        }
        catch (e) {
            this.hub.emitLog(`⚠️ 注入异常: ${e.message}`);
        }
        return null;
    }
    async saveCoverUrl(coverUrl, videoId, title, author) {
        if (!coverUrl)
            return null;
        try {
            const folder = join(this.downloadsDir, author.replace(/[\\/:*?"<>|]/g, '_') || '未知作者', 'covers');
            mkdirSync(folder, { recursive: true });
            const res = await fetch(coverUrl, { redirect: 'follow' });
            if (!res.ok)
                return null;
            const buf = Buffer.from(await res.arrayBuffer());
            const p = join(folder, `${videoId || Date.now()}_${(title || 'cover').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.jpg`);
            writeFileSync(p, buf);
            return p;
        }
        catch {
            return null;
        }
    }
    diagnostics() {
        const catalog = this.store.listCatalog();
        return {
            proxyRunning: this.proxy !== null,
            proxyPort: this.cfg.port,
            downloadsDir: this.downloadsDir,
            catalogCount: catalog.length,
            downloadCount: this.store.listDownloads().length,
            downloader: this.downloader.snapshot(),
            lastProbe: this.lastProbe,
        };
    }
    recentLogs() {
        return this.hub.recentLogs();
    }
    /** Rolling date-window filter for the incremental requirement (rangeDays=0 → all). */
    inRange(createtime, rangeDays) {
        if (!rangeDays || rangeDays <= 0)
            return true;
        const cutoff = Date.now() / 1000 - rangeDays * 86400;
        return createtime >= cutoff;
    }
    /** Watchlist: whether the capture-only-watched gate is on (list non-empty). */
    watchActive() {
        return this.store.listWatched().length > 0;
    }
    /** Watchlist with per-author capture/download counts. */
    watchlistJson() {
        const cats = this.store.listCatalog();
        const dls = new Set(this.store.listDownloads().map((d) => d.object_id));
        return this.store.listWatched().map((w) => ({
            username: w.username,
            nickname: w.nickname,
            enabled: w.enabled,
            captured: cats.filter((c) => c.username === w.username).length,
            downloaded: cats.filter((c) => c.username === w.username && dls.has(c.object_id)).length,
        }));
    }
    /** Capture gate: empty watchlist = capture everything; otherwise only enabled watched authors. */
    shouldCapture(username) {
        if (!username)
            return true;
        const list = this.store.listWatched();
        if (list.length === 0)
            return true;
        return this.store.isWatched(username);
    }
    /** includeAll=true returns every captured video (probe page), else watchlist-filtered (authors/library). */
    catalogJson(includeAll = false) {
        return this.store.listCatalog()
            .filter((r) => (!includeAll && this.watchActive() ? this.store.isWatched(r.username) : true))
            .map((r) => {
            const rec = this.store.hasDownloaded(r.object_id);
            return {
                id: r.object_id,
                title: r.title,
                username: r.username,
                nickname: r.author,
                createtime: r.createtime,
                url: r.url,
                key: r.decode_key ? '<present>' : '',
                duration: r.duration,
                size: rec ? rec.size : r.size,
                downloaded: rec !== null,
                path: rec ? rec.file_path : '',
            };
        });
    }
    downloadsJson() {
        const dls = this.store.listDownloads();
        return dls.map((d) => ({
            videoId: d.object_id,
            title: d.title,
            nickname: d.username,
            username: d.username,
            createtime: 0,
            state: 'done',
            progress: 100,
            path: d.file_path,
        }));
    }
    /** Sidecar（进程级注入器）相关：启动/存活检测。 */
    sidecarExe() {
        return join(PLUGIN_ROOT, 'sidecar', 'wxchannels-inject.exe');
    }
    portOpen(port, host = '127.0.0.1', ms = 800) {
        return new Promise((resolve) => {
            const s = net.connect(port, host);
            s.once('connect', () => { s.destroy(); resolve(true); });
            s.once('error', () => { s.destroy(); resolve(false); });
            setTimeout(() => { s.destroy(); resolve(false); }, ms);
        });
    }
    async isSidecarAlive() {
        return this.portOpen(SIDECAR_PORT);
    }
    async spawnSidecar() {
        const exe = this.sidecarExe();
        if (!existsSync(exe)) {
            this.hub.emitLog(`⚠️ 未找到 sidecar 可执行文件: ${exe}（先运行 npm run build）`);
            return;
        }
        // 1) 先尝试直接启动（宿主本身已管理员时有效）
        const child = spawn(exe, ['-p', String(SIDECAR_PORT)], { detached: true, stdio: 'ignore' });
        child.unref();
        await delay(1500);
        if (await this.isSidecarAlive()) {
            this.hub.emitLog(`✅ sidecar 注入器已运行 (127.0.0.1:${SIDECAR_PORT})`);
            return;
        }
        // 2) 未检测到 → 以管理员权限启动（弹出 UAC，请允许）
        this.hub.emitLog('⏫ sidecar 未检测到监听，将以管理员权限启动（请在 UAC 弹窗中点“是”）');
        const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -Verb RunAs -FilePath '${exe}' -ArgumentList '-p ${SIDECAR_PORT}'`], { detached: true, stdio: 'ignore' });
        ps.unref();
        await delay(2500);
        if (await this.isSidecarAlive())
            this.hub.emitLog(`✅ sidecar 注入器已运行 (127.0.0.1:${SIDECAR_PORT})`);
        else
            this.hub.emitLog('⚠️ sidecar 仍未运行：可能 UAC 被拒绝，或杀软拦截；请手动以管理员运行 sidecar/wxchannels-inject.exe');
    }
    /** Client-driven commands. */
    async ensureStarted() {
        if (this.proxy)
            return;
        await this.start();
    }
    async command(kind, payload = {}) {
        try {
            switch (kind) {
                case 'runProbe':
                    await this.refreshProbe(true);
                    return { ok: true };
                case 'start':
                    await this.ensureStarted();
                    return { ok: true };
                case 'startSidecar':
                    await this.spawnSidecar();
                    await this.refreshProbe(true);
                    return { ok: true };
                case 'installCert':
                    await ensureCa();
                    // Once the CA is trusted the proxy can safely come up.
                    await this.ensureStarted();
                    await this.refreshProbe(true);
                    return { ok: true };
                case 'setProxy': {
                    // The proxy must be listening before the system proxy points at it.
                    await this.ensureStarted();
                    const r = await setSystemProxy(this.cfg.port, Boolean(payload.on));
                    if (r.ok)
                        this.proxyEnabledByUs = Boolean(payload.on);
                    await this.refreshProbe(true);
                    return { ok: r.ok, error: r.error };
                }
                case 'clearCache': {
                    const r = await clearCache();
                    this.hub.emitLog(r.cleaned.length ? `🧹 已清理缓存 ${r.cleaned.length} 个目录，请重启微信` : '缓存目录不存在，无需清理');
                    await this.refreshProbe(true);
                    return { ok: r.failed.length === 0, error: r.failed.length ? '部分缓存目录清理失败（微信可能占用）' : undefined };
                }
                case 'restartWechat': {
                    const wasRunning = await isWechatRunning();
                    await stopWechat();
                    await clearCache();
                    await launchWechat();
                    this.hub.emitLog(wasRunning ? '🔄 已重启微信并清除缓存' : '🔄 已启动微信（缓存已清除）');
                    await this.refreshProbe(true);
                    return { ok: true };
                }
                case 'openChannels':
                    await launchWechat();
                    return { ok: true };
                case 'download': {
                    const ids = Array.isArray(payload.videoIds) ? payload.videoIds.map(String) : [];
                    const rangeDays = Number(payload.rangeDays ?? 0);
                    const rows = this.store.listCatalog();
                    let n = 0;
                    for (const row of rows) {
                        if (ids.length && !ids.includes(row.object_id))
                            continue;
                        if (!this.inRange(row.createtime, rangeDays))
                            continue;
                        if (this.watchActive() && !this.store.isWatched(row.username))
                            continue;
                        this.downloader.enqueue({
                            id: row.object_id,
                            title: row.title,
                            username: row.username,
                            nickname: row.author,
                            url: row.url,
                            key: row.decode_key,
                            createtime: row.createtime,
                            duration: row.duration,
                        });
                        n++;
                    }
                    return { ok: true, error: n ? undefined : '范围内没有可下载的视频' };
                }
                case 'downloadAll': {
                    const rangeDays = Number(payload.rangeDays ?? 0);
                    const rows = this.store.listCatalog();
                    let n = 0;
                    for (const row of rows) {
                        if (!this.inRange(row.createtime, rangeDays))
                            continue;
                        if (this.watchActive() && !this.store.isWatched(row.username))
                            continue;
                        this.downloader.enqueue({
                            id: row.object_id,
                            title: row.title,
                            username: row.username,
                            nickname: row.author,
                            url: row.url,
                            key: row.decode_key,
                            createtime: row.createtime,
                            duration: row.duration,
                        });
                        n++;
                    }
                    return { ok: true, error: n ? undefined : '范围内没有可下载的视频' };
                }
                case 'delete': {
                    const ids = Array.isArray(payload.videoIds) ? payload.videoIds.map(String) : [];
                    let n = 0;
                    for (const id of ids) {
                        const rec = this.store.hasDownloaded(id);
                        if (rec) {
                            if (rec.file_path) {
                                try {
                                    if (existsSync(rec.file_path))
                                        rmSync(rec.file_path, { force: true });
                                }
                                catch {
                                    // file may be locked; record removal still proceeds
                                }
                            }
                            this.store.deleteDownload(id);
                            n++;
                        }
                    }
                    this.hub.emitLog(`🗑️ 已删除 ${n} 个下载文件（列表保留，可重新下载）`);
                    return { ok: true };
                }
                case 'setAutoDownload':
                    this.cfg.autoDownload = Boolean(payload.on);
                    return { ok: true };
                case 'addWatch': {
                    const username = String(payload.username ?? '').trim();
                    const nickname = String(payload.nickname ?? '').trim();
                    if (!username && !nickname)
                        return { ok: false, error: '需要博主标识（username 或昵称）' };
                    const key = username || nickname;
                    this.store.upsertWatch(key, nickname || username, true);
                    this.hub.emitLog(`⭐ 已添加关注博主: ${nickname || username || key}`);
                    return { ok: true };
                }
                case 'removeWatch': {
                    const username = String(payload.username ?? '').trim();
                    if (!username)
                        return { ok: false, error: '缺少 username' };
                    this.store.removeWatch(username);
                    this.hub.emitLog(`🗑️ 已取消关注: ${username}`);
                    return { ok: true };
                }
                case 'openFolder': {
                    const p = String(payload.path ?? '');
                    if (!p)
                        return { ok: false, error: '缺少路径' };
                    spawn('explorer.exe', ['/select,', p], { detached: true, stdio: 'ignore' }).unref();
                    return { ok: true };
                }
                case 'openDownloadsDir':
                    spawn('explorer.exe', [this.downloadsDir], { detached: true, stdio: 'ignore' }).unref();
                    return { ok: true };
                case 'setWatchEnabled': {
                    const username = String(payload.username ?? '').trim();
                    this.store.setWatchEnabled(username, Boolean(payload.on));
                    return { ok: true };
                }
                default:
                    return { ok: false, error: `unknown command: ${kind}` };
            }
        }
        catch (e) {
            return { ok: false, error: e.message };
        }
    }
}
//# sourceMappingURL=service.js.map