/**
 * Local store: mirrors the nobiyou video_catalog upsert (the reference
 * implementation's records.db schema) plus our own download records.
 * Uses node:sqlite (Node 24 built-in) — zero native deps.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export class Store {
    db;
    constructor(dbPath) {
        mkdirSync(dirname(dbPath), { recursive: true });
        this.db = new DatabaseSync(dbPath);
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS video_catalog (
        username TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        object_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        createtime INTEGER NOT NULL DEFAULT 0,
        url TEXT NOT NULL DEFAULT '',
        decode_key TEXT NOT NULL DEFAULT '',
        cover_url TEXT NOT NULL DEFAULT '',
        duration INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (username, object_id)
      );
      CREATE TABLE IF NOT EXISTS download_records (
        object_id TEXT PRIMARY KEY,
        username TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        file_path TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        file_format TEXT NOT NULL DEFAULT '',
        downloaded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS watched (
        username TEXT PRIMARY KEY,
        nickname TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL DEFAULT ''
      );
    `);
    }
    close() {
        this.db.close();
    }
    /** UPSERT a whole batch like the reference save_video_list endpoint. Returns count inserted-or-updated. */
    saveVideoList(username, author, videos) {
        const stmt = this.db.prepare(`
      INSERT INTO video_catalog
        (username, author, object_id, title, createtime, url, decode_key, cover_url, duration, size, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(username, object_id) DO UPDATE SET
        title = excluded.title, createtime = excluded.createtime, url = excluded.url,
        decode_key = excluded.decode_key, cover_url = excluded.cover_url,
        duration = excluded.duration, size = excluded.size, updated_at = datetime('now')
    `);
        let n = 0;
        for (const v of videos) {
            if (!v.id)
                continue;
            stmt.run(username, author || v.nickname || '', v.id, v.title ?? '', Number(v.createtime) || 0, v.url ?? '', v.key ?? '', v.coverUrl ?? v.thumbUrl ?? '', Math.round(Number(v.duration) || 0), Math.round(Number(v.size) || 0));
            n++;
        }
        return n;
    }
    /** All catalog rows, newest first. */
    listCatalog() {
        return this.db.prepare('SELECT * FROM video_catalog ORDER BY updated_at DESC').all();
    }
    listByUsername(username) {
        return this.db.prepare('SELECT * FROM video_catalog WHERE username = ? ORDER BY createtime DESC').all(username);
    }
    isCatalogEmpty() {
        const row = this.db.prepare('SELECT COUNT(*) AS c FROM video_catalog').get();
        return row.c === 0;
    }
    /** Dedup check against download_records (L1 object_id). */
    hasDownloaded(objectId) {
        return this.db.prepare('SELECT * FROM download_records WHERE object_id = ?').get(objectId) ?? null;
    }
    recordDownload(rec) {
        this.db.prepare(`
      INSERT INTO download_records (object_id, username, title, file_path, size, file_format)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(object_id) DO UPDATE SET
        username = excluded.username, title = excluded.title, file_path = excluded.file_path,
        size = excluded.size, file_format = excluded.file_format, downloaded_at = datetime('now')
    `).run(rec.object_id, rec.username, rec.title, rec.file_path, rec.size, rec.file_format);
    }
    listDownloads() {
        return this.db.prepare('SELECT * FROM download_records ORDER BY downloaded_at DESC').all();
    }
    deleteDownload(objectId) {
        const r = this.db.prepare('DELETE FROM download_records WHERE object_id = ?').run(objectId);
        return r.changes > 0;
    }
    /* ---------- watched authors (关注清单) ---------- */
    listWatched() {
        return this.db.prepare('SELECT * FROM watched ORDER BY created_at DESC').all();
    }
    /** Upsert a watched author, keyed by username (nickname kept for display/matching). */
    upsertWatch(username, nickname, enabled = true) {
        this.db.prepare(`
      INSERT INTO watched (username, nickname, enabled) VALUES (?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET nickname = excluded.nickname, enabled = excluded.enabled
    `).run(username, nickname, enabled ? 1 : 0);
    }
    removeWatch(username) {
        this.db.prepare('DELETE FROM watched WHERE username = ?').run(username);
    }
    setWatchEnabled(username, enabled) {
        this.db.prepare('UPDATE watched SET enabled = ? WHERE username = ?').run(enabled ? 1 : 0, username);
    }
    isWatched(username) {
        const row = this.db.prepare('SELECT enabled FROM watched WHERE username = ?').get(username);
        return row !== undefined && row.enabled === 1;
    }
    /* ---------- kv settings ---------- */
    getSetting(key) {
        const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(key);
        return row ? row.v : null;
    }
    setSetting(key, value) {
        this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, value);
    }
}
//# sourceMappingURL=store.js.map