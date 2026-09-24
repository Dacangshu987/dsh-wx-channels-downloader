import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CA_CN } from '../config.js';
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
    return { result, wechatExe: wechatInstalled ? 'found' : null };
}
/** Persist the system proxy config (HKCU WinINET only; Chromium webviews honor it). */
export async function setSystemProxy(port, on) {
    try {
        const script = `
$p = '${INTERNET_SETTINGS}'
if (${on ? '1' : '0'}) {
  New-Item -Path $p -Force | Out-Null
  Set-ItemProperty -Path $p -Name ProxyEnable -Value 1
  Set-ItemProperty -Path $p -Name ProxyServer -Value '127.0.0.1:${port}'
} else {
  Set-ItemProperty -Path $p -Name ProxyEnable -Value 0 -ErrorAction SilentlyContinue
}
Write-Output 'ok'
`;
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, maxBuffer: 1024 * 1024 });
        return { ok: true };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
}
//# sourceMappingURL=probe.js.map