import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** Plugin-owned data home (certs, downloads, records.db). */
export function dataHome() {
    const base = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
        ? process.env.DSH_HOME
        : join(homedir(), '.dsh');
    return join(base, 'wx-channels');
}
export function certsDir() {
    return join(dataHome(), 'certs');
}
export function defaultDownloadsDir() {
    return join(dataHome(), 'downloads');
}
export function recordsDbPath() {
    return join(dataHome(), 'records.db');
}
/** Where setSystemProxy persists the user's previous WinINET proxy settings. */
export function proxyBackupPath() {
    return join(dataHome(), 'proxy-backup.json');
}
export function caCertPath() {
    return join(certsDir(), 'wxdown-ca.cer');
}
export function caKeyPath() {
    return join(certsDir(), 'wxdown-ca.key.pem');
}
export function leafCertPath(host) {
    return join(certsDir(), `leaf-${host.replace(/[^a-z0-9.-]/gi, '_')}.pem`);
}
export function leafKeyPath(host) {
    return join(certsDir(), `leaf-${host.replace(/[^a-z0-9.-]/gi, '_')}.key.pem`);
}
/** WeChat install detection candidates (registry first, common paths fallback). */
export function wechatExeCandidates() {
    const candidates = [];
    const pf = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const pf64 = process.env.ProgramFiles ?? 'C:\\Program Files';
    candidates.push(join(pf, 'Tencent', 'Weixin', 'Weixin.exe'));
    candidates.push(join(pf64, 'Tencent', 'Weixin', 'Weixin.exe'));
    candidates.push(join(process.env.LOCALAPPDATA ?? '', 'Tencent', 'Weixin', 'Weixin.exe'));
    candidates.push(join(pf, 'Tencent', 'WeChat', 'WeChat.exe'));
    return candidates;
}
/** WeChat chromium profile cache dirs (4.x first, then legacy). */
export function radiumCacheDirs() {
    const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return [
        join(roaming, 'Tencent', 'xwechat', 'radium', 'web', 'profiles'),
        join(roaming, 'Tencent', 'WeChat', 'radium', 'web', 'profiles'),
    ];
}
export function firstExisting(dir) {
    return existsSync(dir) ? dir : null;
}
export function firstExistingOf(dirs) {
    for (const d of dirs) {
        const hit = firstExisting(d);
        if (hit)
            return hit;
    }
    return null;
}
//# sourceMappingURL=paths.js.map