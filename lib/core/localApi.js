import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'inject');
function readJson(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw.trim())
                return resolve({});
            try {
                resolve(JSON.parse(raw));
            }
            catch {
                resolve({});
            }
        });
        req.on('error', () => resolve({}));
    });
}
function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
    });
    res.end(payload);
}
function empty(res) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    res.end('{}');
}
function asInt(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
}
/** Builds a WxVideo from either a profile payload or a catalog-style row. */
export function normalizeProfileToVideo(raw, username) {
    const media = (raw.media && typeof raw.media === 'object' ? raw.media : {});
    const spec = Array.isArray(media.spec) && media.spec.length ? media.spec[0] : {};
    const id = String(raw.id ?? '');
    if (!id)
        return null;
    const url = String(raw.url ?? (media.url ? String(media.url) + String(media.urlToken ?? '') : ''));
    const contact = (raw.contact && typeof raw.contact === 'object' ? raw.contact : {});
    const nickname = String(raw.nickname ?? contact.nickname ?? '');
    return {
        id,
        nonceId: raw.nonce_id ? String(raw.nonce_id) : undefined,
        title: String(raw.title ?? ''),
        username: username || String(contact.username ?? raw.username ?? ''),
        nickname,
        createtime: asInt(raw.createtime ?? raw.create_time),
        url,
        key: String(raw.key ?? media.decodeKey ?? ''),
        coverUrl: String(raw.coverUrl ?? media.coverUrl ?? media.thumbUrl ?? ''),
        thumbUrl: String(raw.thumbUrl ?? media.thumbUrl ?? ''),
        duration: asInt(raw.duration ?? media.durationMs),
        size: asInt(raw.size ?? media.fileSize),
        type: raw.type === 'picture' ? 'picture' : raw.type === 'live_replay' ? 'live_replay' : 'media',
        fileFormat: String(spec.fileFormat ?? ''),
        width: asInt(raw.width ?? media.width ?? spec.width),
        height: asInt(raw.height ?? media.height ?? spec.height),
        likeCount: asInt(raw.likeCount),
        commentCount: asInt(raw.commentCount),
        forwardCount: asInt(raw.forwardCount),
    };
}
export function handleLocalApi(ctx, req, res) {
    const pathname = (req.url ?? '/').split('?')[0];
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'Content-Type, X-Local-Auth',
        });
        res.end();
        return true;
    }
    // Injected pages pass the shared secret in X-Local-Auth. When one is
    // configured, enforce it on every API endpoint: this is a plain-HTTP
    // localhost listener, so any local process/webpage could otherwise call
    // download_video etc. (Static page libs below stay unauthenticated —
    // <script src> tags cannot send headers.)
    if (pathname.startsWith('/__wx_channels_api/')) {
        const expected = ctx.token();
        if (expected && req.headers['x-local-auth'] !== expected) {
            json(res, 401, { success: false, code: -1, message: '未授权的本地 API 调用（X-Local-Auth 不匹配）' });
            return true;
        }
    }
    if (pathname === '/__wx_channels_api/profile' && req.method === 'POST') {
        void (async () => {
            const body = (await readJson(req));
            const v = normalizeProfileToVideo(body, '');
            if (v) {
                if (ctx.shouldCapture && !ctx.shouldCapture(v.username, v.nickname)) {
                    empty(res);
                    return;
                }
                ctx.store.saveVideoList(v.username || '未关注', v.nickname, [v]);
                ctx.hub.emitCaptured(v);
                if (ctx.autoDownload())
                    ctx.downloader.enqueue(v);
            }
            empty(res);
        })();
        return true;
    }
    if (pathname === '/__wx_channels_api/tip' && req.method === 'POST') {
        void (async () => {
            const body = await readJson(req);
            const msg = typeof body === 'string' ? body : body?.msg ?? '';
            if (msg)
                ctx.hub.emitLog(msg);
            empty(res);
        })();
        return true;
    }
    if (pathname === '/__wx_channels_api/page_url' && req.method === 'POST') {
        void (async () => {
            await readJson(req);
            empty(res);
        })();
        return true;
    }
    if (pathname === '/__wx_channels_api/inject_health' && req.method === 'POST') {
        void (async () => {
            await readJson(req);
            empty(res);
        })();
        return true;
    }
    if (pathname === '/__wx_channels_api/save_video_list' && req.method === 'POST') {
        void (async () => {
            const body = (await readJson(req));
            const videos = Array.isArray(body?.videos) ? body.videos : [];
            const username = body?.username ?? '';
            if (!videos.length) {
                json(res, 400, { code: -1, message: '无视频列表' });
                return;
            }
            const accepted = videos.filter((v) => {
                if (!v.id)
                    return false;
                if (!ctx.shouldCapture)
                    return true;
                return ctx.shouldCapture(v.username || username, v.nickname || body?.author || '');
            });
            ctx.hub.emitLog(`📥 save_video_list 收到 ${videos.length} 条（接受 ${accepted.length}${accepted.length < videos.length ? `/忽略 ${videos.length - accepted.length}` : ''}，作者=${body?.author || username || '?'}）`);
            const n = ctx.store.saveVideoList(username, body?.author ?? '', accepted);
            for (const v of accepted) {
                ctx.hub.emitCaptured({ ...v, username: v.username || username });
                if (ctx.autoDownload())
                    ctx.downloader.enqueue({ ...v, username: v.username || username });
            }
            json(res, 200, { code: 0, message: `success:${n}${accepted.length < videos.length ? `/ignored:${videos.length - accepted.length}` : ''}` });
        })();
        return true;
    }
    if (pathname === '/__wx_channels_api/download_video' && req.method === 'POST') {
        void (async () => {
            const body = (await readJson(req));
            const url = String(body.videoUrl ?? '');
            if (!url) {
                json(res, 400, { success: false, error: '视频URL不能为空' });
                return;
            }
            const v = {
                id: String(body.videoId ?? ''),
                title: String(body.title ?? ''),
                url,
                key: String(body.key ?? ''),
                username: String(body.username ?? ''),
                nickname: String(body.author ?? ''),
                fileFormat: String(body.fileFormat ?? ''),
                width: asInt(body.width),
                height: asInt(body.height),
                createtime: asInt(body.createtime),
            };
            const result = ctx.downloader.enqueue(v, Boolean(body.forceSave));
            ctx.hub.emitLog(`📥 download_video: ${String(body.title ?? '').slice(0, 30)}（${result.skipped ? '跳过' : result.started ? '已入队' : '未入队'}）`);
            json(res, 200, { success: true, ...result });
        })();
        return true;
    }
    if (pathname === '/__wx_channels_api/save_cover' && req.method === 'POST') {
        void (async () => {
            const body = (await readJson(req));
            const coverUrl = String(body.coverUrl ?? '');
            if (coverUrl) {
                const p = await ctx.saveCoverUrl(coverUrl, String(body.videoId ?? ''), String(body.title ?? ''), String(body.author ?? ''));
                json(res, 200, { success: true, path: p ?? '', message: p ? '封面已保存' : '封面保存失败' });
            }
            else {
                json(res, 400, { success: false, error: 'coverUrl 为空' });
            }
        })();
        return true;
    }
    if (pathname === '/__wx_channels_api/batch_start' && req.method === 'POST') {
        void (async () => {
            const body = (await readJson(req));
            const videos = Array.isArray(body?.videos) ? body.videos : [];
            if (!videos.length) {
                json(res, 400, { success: false, code: -1, message: '视频列表为空' });
                return;
            }
            let queued = 0;
            for (const raw of videos) {
                const v = {
                    id: String(raw.id ?? ''),
                    title: String(raw.title ?? ''),
                    url: String(raw.url ?? ''),
                    key: String(raw.key ?? raw.decodeKey ?? ''),
                    username: String(raw.username ?? ''),
                    nickname: String(raw.author ?? raw.authorName ?? raw.nickname ?? ''),
                    fileFormat: String(raw.fileFormat ?? ''),
                    width: asInt(raw.width),
                    height: asInt(raw.height),
                    createtime: asInt(raw.createtime ?? raw.createTime),
                    coverUrl: String(raw.coverUrl ?? ''),
                    duration: asInt(raw.duration ?? raw.durationMs),
                    size: asInt(raw.size),
                };
                if (v.id && v.url) {
                    ctx.downloader.enqueue(v, Boolean(body?.forceRedownload));
                    queued++;
                }
            }
            ctx.hub.emitLog(`📥 batch_start 收到 ${videos.length} 条（入队 ${queued}）`);
            json(res, 200, { success: true, code: 0, message: '批量下载已启动' });
        })();
        return true;
    }
    if (pathname === '/__wx_channels_api/batch_progress' || pathname === '/__wx_channels_api/batch_download_status') {
        const snap = ctx.downloader.snapshot();
        json(res, 200, {
            success: true,
            code: 0,
            data: {
                running: snap.running,
                total: snap.total,
                success: snap.success,
                failed: snap.failed,
                skipped: snap.skipped,
                tasks: snap.tasks,
            },
        });
        return true;
    }
    if (pathname === '/__wx_channels_api/batch_cancel' || pathname === '/__wx_channels_api/batch_resume' || pathname === '/__wx_channels_api/batch_clear') {
        if (pathname === '/__wx_channels_api/batch_clear')
            ctx.downloader.clear();
        json(res, 200, { success: true, code: 0, message: 'ok' });
        return true;
    }
    if (pathname === '/__wx_channels_api/batch_failed') {
        json(res, 200, { success: true, code: 0, data: [] });
        return true;
    }
    if (pathname === '/__wx_channels_api/record_download') {
        void (async () => {
            await readJson(req);
            json(res, 200, { success: true });
        })();
        return true;
    }
    // Vendored page libs (FileSaver / jszip) served same-origin.
    if (req.method === 'GET' && (pathname.endsWith('/FileSaver.min.js') || pathname.endsWith('/jszip.min.js'))) {
        const name = pathname.split('/').pop();
        const p = join(dirname(ASSETS), 'lib', name);
        if (!existsSync(p)) {
            res.writeHead(404).end();
            return true;
        }
        res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'public, max-age=3600' });
        res.end(readFileSync(p));
        return true;
    }
    return false;
}
/**
 * Dispatch a local-API call without a real HTTP request/response — used by the
 * Go sidecar relay (/wxchannels/ingest). Returns null when the path is not
 * handled by the local API.
 */
export function dispatchLocalApi(ctx, method, pathname, rawBody, headers = {}) {
    return new Promise((resolve) => {
        let status = 200;
        const outHeaders = {};
        let body = '';
        let ended = false;
        let done = () => { };
        const finished = new Promise((r) => { done = r; });
        const res = {
            writeHead(s, h) {
                status = s;
                if (h)
                    for (const [k, v] of Object.entries(h))
                        outHeaders[k] = String(v);
            },
            end(b) {
                if (!ended) {
                    ended = true;
                    body = String(b ?? '');
                    done();
                }
            },
            write() { return true; },
        };
        const req = {
            method,
            url: pathname,
            headers,
            on(_type, cb) {
                if (_type === 'data')
                    queueMicrotask(() => cb(Buffer.from(rawBody, 'utf8')));
                if (_type === 'end')
                    queueMicrotask(() => cb());
                if (_type === 'error')
                    queueMicrotask(() => cb(new Error('closed')));
                return req;
            },
        };
        const handled = handleLocalApi(ctx, req, res);
        const timeout = setTimeout(() => {
            if (!ended) {
                ended = true;
                done();
            }
        }, 5000);
        void finished.then(() => {
            clearTimeout(timeout);
            resolve(handled ? { status, headers: outHeaders, body } : null);
        });
    });
}
//# sourceMappingURL=localApi.js.map