/**
 * CA + leaf certificate management via Windows PowerShell's built-in
 * certificate cmdlets (no node-gyp / node-forge needed). The CA lives in
 * the CurrentUser My store with an exportable key; it is installed into
 * CurrentUser Root (no administrator required for per-user trust).
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { CA_CN } from '../config.js'
import { caCertPath, caKeyPath, certsDir, leafCertPath, leafKeyPath } from './paths.js'

const execFileAsync = promisify(execFile)

function ps(script: string): Promise<string> {
  return execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  }).then((r) => r.stdout)
}

const KEY_SECRET_FILE = 'ca.pass.txt'

function caPass(): string {
  const p = `${certsDir()}/${KEY_SECRET_FILE}`
  if (existsSync(p)) return readFileSync(p, 'utf8').trim()
  const pass = randomBytes(18).toString('base64url')
  writeFileSync(p, pass, 'utf8')
  return pass
}

function pfxPath(kind: 'ca' | 'leaf', host?: string): string {
  if (kind === 'ca') return `${certsDir()}/ca.pfx`
  return `${certsDir()}/leaf-${host!.replace(/[^a-z0-9.-]/gi, '_')}.pfx`
}

/** Ensure the CA exists and is installed into the current-user Root store. */
export async function ensureCa(): Promise<void> {
  mkdirSync(certsDir(), { recursive: true })
  const cert = caCertPath()
  const pfx = pfxPath('ca')
  if (existsSync(cert) && existsSync(pfx) && (await isCaInstalled())) return
  const pass = caPass()
  const script = `
$ErrorActionPreference = 'Stop'
$existing = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -like '*${CA_CN}*' } | Select-Object -First 1
if (-not $existing) {
  $ca = New-SelfSignedCertificate -Subject "CN=${CA_CN}" -Type Custom -KeyUsage CertSign,DigitalSignature,KeyEncipherment -TextExtension @('2.5.29.19={critical}{text}CA=TRUE&pathlen=1') -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable -CertStoreLocation Cert:\\CurrentUser\\My
} else { $ca = $existing }
Export-Certificate -Cert $ca -FilePath '${cert.replaceAll("'", "''")}' -Type CERT | Out-Null
Export-PfxCertificate -Cert $ca -FilePath '${pfx.replaceAll("'", "''")}' -Password (ConvertTo-SecureString -AsPlainText '${pass}' -Force) | Out-Null
Write-Output 'ok'
`
  await ps(script)
  await installToRoot(cert)
}

/** Generate (once) a leaf cert for `host` signed by our CA, export its pfx+key PEM. */
export async function ensureLeaf(host: string): Promise<{ pfx: Buffer; pass: string }> {
  mkdirSync(certsDir(), { recursive: true })
  const pfx = pfxPath('leaf', host)
  const pass = caPass()
  if (!existsSync(pfx)) {
    const script = `
$ErrorActionPreference = 'Stop'
$ca = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -like '*${CA_CN}*' } | Select-Object -First 1
if (-not $ca) { throw 'CA not found' }
$leaf = New-SelfSignedCertificate -Subject "CN=${host}" -DnsName ${host} -Signer $ca -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable -CertStoreLocation Cert:\\CurrentUser\\My
Export-PfxCertificate -Cert $leaf -FilePath '${pfx.replaceAll("'", "''")}' -Password (ConvertTo-SecureString -AsPlainText '${pass}' -Force) | Out-Null
Write-Output 'ok'
`
    await ps(script)
  }
  return { pfx: readFileSync(pfx), pass }
}

/** Whether our CA is trusted in the current-user Root store. */
export async function isCaInstalled(): Promise<boolean> {
  try {
    const script = `(Get-ChildItem Cert:\\CurrentUser\\Root -ErrorAction SilentlyContinue | Where-Object { $_.Subject -like '*${CA_CN}*' }).Count`
    const out = (await ps(script)).trim()
    if (out !== '' && Number(out) > 0) return true
  } catch {
    // fall through to certutil check
  }
  try {
    const { execFileAsync } = await import('./certUtil.js')
    const out = await execFileAsync('certutil.exe', ['-user', '-store', 'Root', CA_CN], { windowsHide: true, maxBuffer: 1024 * 1024 })
    return /DSH WxChannels/i.test(out.stdout)
  } catch {
    return false
  }
}

/** Install the CA .cer into the current-user Root store with several fallbacks (no UI, no admin). */
export async function installToRoot(cerPath: string): Promise<boolean> {
  // 1) PowerShell Import-Certificate (silent in an interactive session)
  try {
    await ps(`Import-Certificate -FilePath '${cerPath.replaceAll("'", "''")}' -CertStoreLocation Cert:\\CurrentUser\\Root | Out-Null; Write-Output 'ok'`)
    if (await isCaInstalled()) return true
  } catch {
    // try next
  }
  // 2) certutil (works without the Cert: PSDrive)
  try {
    const { execFileAsync } = await import('./certUtil.js')
    const out = await execFileAsync('certutil.exe', ['-user', '-addstore', 'Root', cerPath], { windowsHide: true, maxBuffer: 1024 * 1024 })
    if (out.stderr && /failed|error/i.test(out.stderr)) throw new Error(out.stderr)
    if (await isCaInstalled()) return true
  } catch {
    // try next
  }
  // 3) .NET X509Store API
  try {
    const script = `
$c = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new('${cerPath.replaceAll("'", "''")}')
$s = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root','CurrentUser')
$s.Open('ReadWrite'); $s.Add($c); $s.Close()
Write-Output 'ok'
`
    await ps(script)
    return await isCaInstalled()
  } catch {
    return false
  }
}

/** Remove our CA from Root and My (used by uninstall). */
export async function uninstallCa(): Promise<void> {
  const script = `
Get-ChildItem Cert:\\CurrentUser\\Root -ErrorAction SilentlyContinue | Where-Object { $_.Subject -like '*${CA_CN}*' } | Remove-Item -ErrorAction SilentlyContinue
Get-ChildItem Cert:\\CurrentUser\\My -ErrorAction SilentlyContinue | Where-Object { $_.Subject -like '*${CA_CN}*' } | Remove-Item -ErrorAction SilentlyContinue
`
  await ps(script)
  for (const p of [caCertPath(), caKeyPath()]) {
    if (existsSync(p)) rmSync(p, { force: true })
  }
}