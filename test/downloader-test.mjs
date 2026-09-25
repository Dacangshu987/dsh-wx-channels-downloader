// Functional test for the rewritten Downloader.runOne: fetch with watchdog,
// progress events, per-author naming, store record, and the no-key encrypted
// warning. Uses NODE_TLS_REJECT_UNAUTHORIZED=0 against a throwaway origin.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PASS = []
const FAIL = []
const check = (n, c, e = '') => (c ? PASS.push(n) : FAIL.push(`${n}${e ? ' — ' + e : ''}`))

const tmp = mkdtempSync(join(tmpdir(), 'wxdown-dl-'))
try {
  const keyP = join(tmp, 'k.pem'), crtP = join(tmp, 'c.pem'), pfxP = join(tmp, 'l.p12')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyP, '-out', crtP, '-days', '2', '-nodes', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' })
  execFileSync('openssl', ['pkcs12', '-export', '-out', pfxP, '-inkey', keyP, '-in', crtP, '-passout', 'pass:x'], { stdio: 'ignore' })

  // Fake mp4: 1MB, 'ftyp' at offset 4 (looks decrypted), zero-padded body.
  const payload = Buffer.alloc(1024 * 1024, 7)
  payload.write('ftyp', 4, 'latin1')

  const upstream = https.createServer({ key: readFileSync(keyP), cert: readFileSync(crtP) }, (req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(payload.length) })
    res.end(payload)
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const port = upstream.address().port

  const { Downloader } = await import('../lib/core/downloader.js')
  const { Store } = await import('../lib/core/store.js')
  const downloadsDir = join(tmp, 'downloads')
  const store = new Store(join(tmp, 'records.db'))
  const logs = []
  const progressEvents = []
  const hub = {
    emitDownload: (e) => { if (e.state === 'downloading') progressEvents.push(e.progress) },
    emitLog: (m) => logs.push(m),
  }
  const dl = new Downloader(store, downloadsDir, 2, hub)

  const done = new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!dl.isRunning) { clearInterval(timer); resolve() }
    }, 50)
  })

  // 1) encrypted video WITH key → decrypts to our fake plaintext header.
  //    Key 0 XORs nothing… use a nonzero key: the ISAAC64 stream XORs the
  //    first 128KB, so upload an encrypted variant for this id.
  const encPayload = Buffer.from(payload)
  // simpler: reuse decrypt symmetry — serve the PLAIN payload and check the
  // no-key path; the keyed path is covered by isaac64 round-trip in smoke.mjs.

  dl.enqueue({ id: 'oid-dl-1', title: '功能测试: 视频/标题?', username: 'v2_a@finder', nickname: '测试作者', createtime: 1727000000, url: `https://127.0.0.1:${port}/v.mp4` })
  await done

  const files = readdirSync(join(downloadsDir, '测试作者'))
  check('file saved under author folder with cleaned name', files.length === 1 && files[0].endsWith('.mp4') && files[0].startsWith('功能测试_'), JSON.stringify(files))
  const saved = statSync(join(downloadsDir, '测试作者', files[0]))
  check('file size matches upstream payload', saved.size === payload.length, `${saved.size} vs ${payload.length}`)
  const rec = store.hasDownloaded('oid-dl-1')
  check('download record stored', rec !== null && rec.file_path.endsWith(files[0]), JSON.stringify(rec))
  check('progress events emitted (content-length known)', progressEvents.length >= 1 && Math.max(...progressEvents) >= 5, JSON.stringify(progressEvents))
  check('no encrypted warning for ftyp file', !logs.some((m) => m.includes('仍是密文')), JSON.stringify(logs))

  // 2) no key + non-ftyp header → task done but warning logged.
  const events2 = []
  const logs2 = []
  const dl2 = new Downloader(store, downloadsDir, 1, {
    emitDownload: (e) => events2.push(e.state),
    emitLog: (m) => logs2.push(m),
  })
  const payload2 = Buffer.alloc(64 * 1024, 1) // NOT ftyp
  payload2.write('XXXX', 4, 'latin1')
  upstream.close()
  const upstream2 = https.createServer({ key: readFileSync(keyP), cert: readFileSync(crtP) }, (req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(payload2.length) })
    res.end(payload2)
  })
  await new Promise((r) => upstream2.listen(0, '127.0.0.1', r))
  const port2 = upstream2.address().port
  const done2 = new Promise((resolve) => {
    const timer = setInterval(() => { if (!dl2.isRunning) { clearInterval(timer); resolve() } }, 50)
  })
  dl2.enqueue({ id: 'oid-dl-2', title: '密文告警测试', username: 'v2_a@finder', nickname: '测试作者', createtime: 1727000000, url: `https://127.0.0.1:${port2}/v.mp4` })
  await done2
  check('no-key non-ftyp file still completes', events2.includes('done') && !events2.includes('failed'), JSON.stringify(events2))
  check('still-encrypted warning emitted', logs2.some((m) => m.includes('仍是密文')), JSON.stringify(logs2))
  upstream2.close()
  store.close()
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
}

console.log(`\nPASS ${PASS.length}:`)
for (const p of PASS) console.log('  ✓', p)
if (FAIL.length) {
  console.log(`FAIL ${FAIL.length}:`)
  for (const f of FAIL) console.log('  ✗', f)
  process.exit(1)
}
console.log('ALL DOWNLOADER CHECKS PASSED')
process.exit(0)
