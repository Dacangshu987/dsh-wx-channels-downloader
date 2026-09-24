/**
 * Downloader: fetch the finder media URL with page headers, decrypt the
 * 128KB encrypted prefix (ISAAC64), dedup by object_id, and archive under
 * {downloads}/{作者}/{标题}_{质量}.mp4. Mirrors the reference
 * download_video handler (fetch + decrypt + dedup + per-author folder).
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { decryptFileInPlace, DECRYPT_PREFIX_LEN } from './isaac64.js';
const WINDOWS_RESERVED = /[\\/:*?"<>|\u0000-\u001f]/g;
const TRAILING_DOTS_SPACES = /[. ]+$/g;
export function cleanFilename(name, maxLen = 120) {
    let s = String(name ?? '')
        .replace(WINDOWS_RESERVED, '_')
        .replace(TRAILING_DOTS_SPACES, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (s.length > maxLen)
        s = s.slice(0, maxLen);
    return s || 'untitled';
}
export class Downloader {
    queue = [];
    running = 0;
    store;
    downloadsDir;
    maxConcurrent;
    hub;
    tasks = new Map();
    constructor(store, downloadsDir, maxConcurrent, hub) {
        this.store = store;
        this.downloadsDir = downloadsDir;
        this.maxConcurrent = Math.max(1, maxConcurrent);
        this.hub = hub;
    }
    get isRunning() {
        return this.running > 0 || this.queue.length > 0;
    }
    snapshot() {
        let success = 0;
        let failed = 0;
        let skipped = 0;
        const tasks = [];
        for (const t of this.tasks.values()) {
            tasks.push({ ...t });
            if (t.state === 'done')
                success++;
            else if (t.state === 'failed')
                failed++;
            else if (t.state === 'skipped')
                skipped++;
        }
        return { running: this.isRunning, total: tasks.length, success, failed, skipped, tasks };
    }
    clear() {
        if (this.running > 0 || this.queue.length)
            return;
        this.tasks.clear();
    }
    /** Enqueue one video; dedup happens at run time (object_id against DB). */
    enqueue(v, force = false) {
        if (!v.id || !v.url)
            return { started: false, skipped: false, message: 'missing id/url' };
        if (!force) {
            const existing = this.store.hasDownloaded(v.id);
            if (existing && existsSync(existing.file_path)) {
                this.setTask(v.id, { title: v.title, nickname: v.nickname, username: v.username, createtime: v.createtime, state: 'skipped', progress: 100, path: existing.file_path });
                return { started: false, skipped: true, message: '已存在，跳过下载' };
            }
        }
        if (this.tasks.has(v.id) && (this.tasks.get(v.id).state === 'downloading' || this.tasks.get(v.id).state === 'pending')) {
            return { started: true, skipped: false };
        }
        this.setTask(v.id, { title: v.title, nickname: v.nickname, username: v.username, createtime: v.createtime, state: 'pending', progress: 0 });
        this.queue.push({ ...v });
        this.drain();
        return { started: true, skipped: false };
    }
    setTask(id, patch) {
        const prev = this.tasks.get(id) ?? { id, title: patch.title, nickname: patch.nickname, username: patch.username, createtime: patch.createtime, state: 'pending', progress: 0 };
        this.tasks.set(id, { ...prev, ...patch, id });
    }
    drain() {
        while (this.running < this.maxConcurrent && this.queue.length > 0) {
            const v = this.queue.shift();
            this.running++;
            void this.runOne(v).finally(() => {
                this.running--;
                this.drain();
            });
        }
    }
    async runOne(v) {
        const started = Date.now();
        this.setTask(v.id, { title: v.title, nickname: v.nickname, username: v.username, createtime: v.createtime, state: 'downloading', progress: 0, startAt: started });
        this.hub.emitDownload({ videoId: v.id, title: v.title, nickname: v.nickname, username: v.username, createtime: v.createtime, state: 'downloading', progress: 0 });
        const tmpPath = join(dirname(this.downloadsDir), `.tmp-${v.id}-${Date.now()}.mp4`);
        try {
            const headers = {
                Origin: 'https://channels.weixin.qq.com',
                Referer: 'https://channels.weixin.qq.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                'Accept-Encoding': 'identity',
            };
            if (v.username && v.nickname) {
                headers['X-Requested-With'] = 'wxdown';
            }
            const controller = new AbortController();
            const res = await fetch(v.url, { headers, redirect: 'follow', signal: controller.signal });
            if (!res.ok || !res.body) {
                throw new Error(`HTTP ${res.status} ${res.statusText}`);
            }
            const total = Number(res.headers.get('content-length') ?? 0);
            await pipeline(Readable.fromWeb(res.body), createWriteStream(tmpPath));
            let size = statSync(tmpPath).size;
            if (size <= 0)
                throw new Error('下载文件为空');
            if (v.key) {
                const r = decryptFileInPlace(tmpPath, DECRYPT_PREFIX_LEN, BigInt(v.key));
                if (!r.ok)
                    throw new Error(`解密失败: ${r.error}`);
            }
            const authorFolder = cleanFilename(v.nickname || '未知作者', 60);
            const dir = join(this.downloadsDir, authorFolder);
            mkdirSync(dir, { recursive: true });
            const quality = [v.fileFormat, v.width && v.height ? `${v.width}x${v.height}` : ''].filter(Boolean).join('_');
            let name = cleanFilename(v.title || v.id, 100);
            if (quality)
                name = `${name}_${quality}`;
            if (!name.toLowerCase().endsWith('.mp4'))
                name += '.mp4';
            name = basename(name);
            const finalPath = uniquePath(join(dir, name));
            renameSync(tmpPath, finalPath);
            this.store.recordDownload({
                object_id: v.id,
                username: v.username,
                title: v.title,
                file_path: finalPath,
                size,
                file_format: quality,
            });
            this.setTask(v.id, { title: v.title, nickname: v.nickname, username: v.username, createtime: v.createtime, state: 'done', progress: 100, path: finalPath, endAt: Date.now() });
            this.hub.emitDownload({ videoId: v.id, title: v.title, nickname: v.nickname, username: v.username, createtime: v.createtime, state: 'done', progress: 100, path: finalPath });
            this.hub.emitLog(`✓ 已下载: ${authorFolder}/${name}`);
        }
        catch (err) {
            try {
                rmSync(tmpPath, { force: true });
            }
            catch {
                // ignore
            }
            const message = err instanceof Error ? err.message : String(err);
            this.setTask(v.id, { title: v.title, nickname: v.nickname, username: v.username, createtime: v.createtime, state: 'failed', progress: 0, error: message, endAt: Date.now() });
            this.hub.emitDownload({ videoId: v.id, title: v.title, nickname: v.nickname, username: v.username, createtime: v.createtime, state: 'failed', progress: 0, error: message });
            this.hub.emitLog(`✗ 下载失败: ${v.title?.slice(0, 40)} — ${message}`);
        }
    }
}
function uniquePath(p) {
    if (!existsSync(p))
        return p;
    const ext = p.endsWith('.mp4') ? '.mp4' : '';
    const base = ext ? p.slice(0, -ext.length) : p;
    for (let i = 1; i < 1000; i++) {
        const candidate = `${base}(${i})${ext}`;
        if (!existsSync(candidate))
            return candidate;
    }
    return `${base}-${Date.now()}${ext}`;
}
//# sourceMappingURL=downloader.js.map