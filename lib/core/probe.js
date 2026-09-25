/**
 * Environment probe: WeChat install/run, CA trust, system proxy, radium
 * cache. This powers the "打开插件 -> 运行探测" step and the checklist the
 * client renders, mirroring the reference's runtime diagnostics.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CA_CN } from '../config.js';
import { proxyBackupPath } from './paths.js';
import { isCaInstalled } from './cert.js';
import { existingCacheDir } from './wechat.js';
import { isWechatInstalled, isWechatRunning } from './wechat.js';
const execFileAsync = promisify(execFile);
const INTERNET_SETTINGS = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
async function readWinInetProxy() {
    try {
        const script = `
$v = Get-ItemProperty -Path '${INTERNET_SETTINGS}' -ErrorAction SilentlyContinue
Write-Output ('enabled=' + $v.ProxyEnable)
Write-Output ('server=' + $v.ProxyServer)
`;
        const out = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, maxBuffer: 1024 * 1024 }).then((r) => r.stdout);
        let enabled = false;
        let server = '';
        for (const line of out.split(/\r?\n/)) {
            const m = /^(enabled|server)=(.*)$/.exec(line.trim());
            if (m) {
                if (m[1] === 'enabled')
                    enabled = m[2] === '1';
                else
                    server = m[2] ?? '';
            }
        }
        return { enabled, server };
    }
    catch {
        return { enabled: false, server: '' };
    }
}
export async function runProbe(deps) {
    const [wechatInstalled, wechatRunning, certInstalled, proxy, cacheDir] = await Promise.all([
        isWechatInstalled(),
        isWechatRunning(),
        isCaInstalled(),
        readWinInetProxy(),
        Promise.resolve(existingCacheDir()),
    ]);
    const expectServer = `127.0.0.1:${deps.port}`;
    const proxySet = proxy.enabled && proxy.server.includes(expectServer);
    const items = [
        {
            id: 'wechat',
            label: '微信已安装',
            status: wechatInstalled ? 'ok' : 'fail',
            detail: wechatInstalled ? '已找到微信主程序' : '未找到微信（Weixin.exe / WeChat.exe）',
        },
        {
            id: 'running',
            label: '微信运行状态',
            status: wechatRunning ? 'warn' : 'ok',
            detail: wechatRunning ? '微信正在运行（如需清缓存需先退出）' : '微信未运行',
        },
        {
            id: 'cert',
            label: `CA 证书（${CA_CN}）`,
            status: certInstalled ? 'ok' : 'fail',
            detail: certInstalled ? '受信任根证书已安装' : '未安装受信任根证书',
            fix: certInstalled ? undefined : 'install-cert',
        },
        {
            id: 'proxy',
            label: '系统代理',
            status: proxySet ? 'ok' : 'warn',
            detail: proxySet ? `已指向 127.0.0.1:${deps.port}` : `未指向 127.0.0.1:${deps.port}（当前: ${proxy.enabled ? proxy.server : '关闭'}）`,
            fix: proxySet ? undefined : 'set-proxy',
        },
        {
            id: 'cache',
            label: '微信页面缓存',
            status: cacheDir ? 'warn' : 'ok',
            detail: cacheDir ? '检测到缓存，注入可能不生效，需清除后重启微信' : '无残留缓存',
            fix: cacheDir ? 'clear-cache-restart' : undefined,
        },
    ];
    const result = {
        running: true,
        at: Date.now(),
        wechatInstalled,
        wechatRunning,
        certInstalled,
        proxySet,
        cachePending: cacheDir !== null,
        items,
    };
    return { result };
}
/** Persist the system proxy config (HKCU WinINET only; Chromium webviews honor it).
 *  Enabling saves the user's previous settings once; disabling restores them
 *  instead of blindly turning the proxy off (which would wipe e.g. Clash). */
export async function setSystemProxy(port, on) {
    try {
        if (on) {
            const current = await readWinInetProxy();
            const ours = `127.0.0.1:${port}`;
            const backup = readProxyBackup();
            if (!backup && !(current.enabled && current.server.includes(ours))) {
                writeProxyBackup({ enabled: current.enabled, server: current.server });
            }
            const script = `
$p = '${INTERNET_SETTINGS}'
New-Item -Path $p -Force | Out-Null
Set-ItemProperty -Path $p -Name ProxyEnable -Value 1
Set-ItemProperty -Path $p -Name ProxyServer -Value '${ours}'
Write-Output 'ok'
`;
            await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, maxBuffer: 1024 * 1024 });
            return { ok: true };
        }
        const backup = readProxyBackup();
        const server = backup?.server ?? '';
        const enabled = backup?.enabled ? 1 : 0;
        const script = `
$p = '${INTERNET_SETTINGS}'
if ('${server.replaceAll("'", "''")}' -ne '') {
  Set-ItemProperty -Path $p -Name ProxyServer -Value '${server.replaceAll("'", "''")}'
} else {
  Remove-ItemProperty -Path $p -Name ProxyServer -ErrorAction SilentlyContinue
}
Set-ItemProperty -Path $p -Name ProxyEnable -Value ${enabled}
Write-Output 'ok'
`;
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, maxBuffer: 1024 * 1024 });
        clearProxyBackup();
        return { ok: true };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
}
function readProxyBackup() {
    try {
        const raw = JSON.parse(readFileSync(proxyBackupPath(), 'utf8'));
        if (typeof raw.server !== 'string' || typeof raw.enabled !== 'boolean')
            return null;
        return { enabled: raw.enabled, server: raw.server };
    }
    catch {
        return null;
    }
}
function writeProxyBackup(b) {
    try {
        mkdirSync(dirname(proxyBackupPath()), { recursive: true });
        writeFileSync(proxyBackupPath(), JSON.stringify(b, null, 2), 'utf8');
    }
    catch {
        // best effort; worst case the restore falls back to ProxyEnable=0
    }
}
function clearProxyBackup() {
    try {
        rmSync(proxyBackupPath(), { force: true });
    }
    catch {
        // ignore
    }
}
//# sourceMappingURL=probe.js.map