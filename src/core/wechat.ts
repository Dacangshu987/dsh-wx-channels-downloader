/**
 * WeChat lifecycle helpers: install detection, process state, cache cleanup,
 * launch, and opening the Channels panel via the weixin://dl/channels scheme.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { firstExistingOf, radiumCacheDirs, wechatExeCandidates } from './paths.js'

const execFileAsync = promisify(execFile)

const PROCESS_NAMES = ['Weixin', 'WeChat', 'WeChatAppEx']

function ps(script: string): Promise<string> {
  return execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  }).then((r) => r.stdout)
}

function isTruthy(s: string): boolean {
  const t = s.trim()
  return t !== '' && t !== '0' && t.toLowerCase() !== 'false'
}

/** Locate the WeChat main executable (registry first, common paths fallback). */
export async function findWechatExe(): Promise<string | null> {
  const script = `
$keys = @(
  'HKCU:\\SOFTWARE\\Tencent\\Weixin',
  'HKCU:\\SOFTWARE\\Tencent\\WeChat',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Tencent\\Weixin',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Tencent\\WeChat',
  'HKLM:\\SOFTWARE\\Tencent\\Weixin',
  'HKLM:\\SOFTWARE\\Tencent\\WeChat'
)
foreach ($k in $keys) {
  try {
    $v = (Get-ItemProperty -Path $k -ErrorAction Stop).InstallPath
    if ($v) { Write-Output $v; exit 0 }
  } catch {}
}
Write-Output ''
`
  try {
    const regPath = (await ps(script)).trim()
    if (regPath) {
      for (const exe of ['Weixin.exe', 'WeChat.exe']) {
        const p = join(regPath, exe)
        if (existsSync(p)) return p
      }
    }
  } catch {
    // continue with fallbacks
  }
  return firstExistingOf(wechatExeCandidates())
}

export async function isWechatInstalled(): Promise<boolean> {
  return (await findWechatExe()) !== null
}

export async function isWechatRunning(): Promise<boolean> {
  const out = await ps(`(Get-Process -Name ${PROCESS_NAMES.join(',')} -ErrorAction SilentlyContinue | Measure-Object).Count`)
  return isTruthy(out) && Number(out.trim()) > 0
}

/** Force-quit WeChat processes (no admin needed for processes owned by the user). */
export async function stopWechat(): Promise<void> {
  await ps(`Stop-Process -Name ${PROCESS_NAMES.join(',')} -Force -ErrorAction SilentlyContinue`)
}

/** Find the radium profile cache dir that currently exists (4.x first). */
export function existingCacheDir(): string | null {
  return firstExistingOf(radiumCacheDirs())
}

/** Delete the radium web profiles so WeChat re-fetches its JS through the proxy. Returns whether something was cleaned. */
export async function clearCache(): Promise<{ cleaned: string[]; failed: string[] }> {
  const cleaned: string[] = []
  const failed: string[] = []
  for (const dir of radiumCacheDirs()) {
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true })
        cleaned.push(dir)
      } catch {
        failed.push(dir)
      }
    }
  }
  return { cleaned, failed }
}

/** Launch WeChat, then open the Channels panel. */
export async function launchWechat(): Promise<{ exe: string | null; opened: boolean }> {
  const exe = await findWechatExe()
  let opened = false
  if (exe) {
    try {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      opened = true
    } catch {
      // fall through
    }
  }
  try {
    await execFileAsync('cmd.exe', ['/c', 'start', '', 'weixin://dl/channels'], { windowsHide: true })
  } catch {
    // the scheme may not exist; the app itself is already launching
  }
  return { exe, opened }
}