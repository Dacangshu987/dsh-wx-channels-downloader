import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Plugin-owned data home (certs, downloads, records.db). */
export function dataHome(): string {
  const base = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(base, 'wx-channels')
}

export function certsDir(): string {
  return join(dataHome(), 'certs')
}

export function defaultDownloadsDir(): string {
  return join(dataHome(), 'downloads')
}

export function recordsDbPath(): string {
  return join(dataHome(), 'records.db')
}

/** Where setSystemProxy persists the user's previous WinINET proxy settings. */
export function proxyBackupPath(): string {
  return join(dataHome(), 'proxy-backup.json')
}

export function caCertPath(): string {
  return join(certsDir(), 'wxdown-ca.cer')
}

export function caKeyPath(): string {
  return join(certsDir(), 'wxdown-ca.key.pem')
}

export function leafCertPath(host: string): string {
  return join(certsDir(), `leaf-${host.replace(/[^a-z0-9.-]/gi, '_')}.pem`)
}

export function leafKeyPath(host: string): string {
  return join(certsDir(), `leaf-${host.replace(/[^a-z0-9.-]/gi, '_')}.key.pem`)
}

/** WeChat install detection candidates (registry first, common paths fallback). */
export function wechatExeCandidates(): string[] {
  const candidates: string[] = []
  const pf = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const pf64 = process.env.ProgramFiles ?? 'C:\\Program Files'
  candidates.push(join(pf, 'Tencent', 'Weixin', 'Weixin.exe'))
  candidates.push(join(pf64, 'Tencent', 'Weixin', 'Weixin.exe'))
  candidates.push(join(process.env.LOCALAPPDATA ?? '', 'Tencent', 'Weixin', 'Weixin.exe'))
  candidates.push(join(pf, 'Tencent', 'WeChat', 'WeChat.exe'))
  return candidates
}

/** WeChat chromium profile cache dirs (4.x first, then legacy). */
export function radiumCacheDirs(): string[] {
  const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return [
    join(roaming, 'Tencent', 'xwechat', 'radium', 'web', 'profiles'),
    join(roaming, 'Tencent', 'WeChat', 'radium', 'web', 'profiles'),
  ]
}

export function firstExisting(dir: string): string | null {
  return existsSync(dir) ? dir : null
}

export function firstExistingOf(dirs: string[]): string | null {
  for (const d of dirs) {
    const hit = firstExisting(d)
    if (hit) return hit
  }
  return null
}