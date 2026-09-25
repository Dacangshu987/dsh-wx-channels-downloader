// Offline smoke test for the plugin's core seams (no system state touched):
//  1. MitmServer end-to-end: CONNECT -> TLS -> inner request -> local API
//     (real handleLocalApi + real Store in a temp dir, token enforcement) and
//     tunneled passthrough to a fake upstream.
//  2. Injector: rewriteHtml + patchJavaScript on synthetic bundles.
//  3. isaac64 decryptBuffer round-trip + edge keys.
// Run: node test/tmp/smoke.mjs
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PASS = []
const FAIL = []
function check(name, cond, extra = '') {
  if (cond) PASS.push(name)
  else FAIL.push(name + (extra ? ` — ${extra}` : ''))
}

const tmp = mkdtempSync(join(tmpdir(), 'wxdown-smoke-'))
try {
  const { MitmServer } = await import('../lib/core/proxy.js')
  const { handleLocalApi } = await import('../lib/core/localApi.js')
  const { Store } = await import('../lib/core/store.js')
  const { Injector } = await import('../lib/core/inject.js')

  const store = new Store(join(tmp, 'records.db'))
  const events = []
  const ctx = {
    store,
    downloader: { enqueue: (v) => events.push(['enqueue', v.id]), snapshot: () => ({ running: false, total: 0, success: 0, failed: 0, skipped: 0, tasks: [] }), clear: () => {} },
    hub: { emitCaptured: (v) => events.push(['captured', v.id]), emitLog: (m) => events.push(['log', m]) },
    token: () => 'secret-token',
    autoDownload: () => false,
    shouldCapture: (u) => u === 'v2_ok@finder',
    saveCoverUrl: async () => null,
  }

  // Throwaway self-signed cert for the fake upstream (Git Bash ships openssl).
  const keyP = join(tmp, 'k.pem'), crtP = join(tmp, 'c.pem'), pfxP = join(tmp, 'leaf.p12')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyP, '-out', crtP, '-days', '2', '-nodes', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' })
  execFileSync('openssl', ['pkcs12', '-export', '-out', pfxP, '-inkey', keyP, '-in', crtP, '-passout', 'pass:smoke'], { stdio: 'ignore' })

  let upstreamHits = 0
  const upstream = https.createServer({ key: readFileSync(keyP), cert: readFileSync(crtP) }, (req, res) => {
    upstreamHits++
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><head><title>t</title></head><body>upstream-ok</body></html>')
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const upstreamPort = upstream.address().port

  // The fake origin is reached via the tunnelConnect (passthrough) path; the
  // MITM'd-host path serves the local API (forward() itself needs the real
  // WeChat origin and is covered by production use).
  const mitm = new MitmServer(0, new Set(['channels.weixin.qq.com']), { pfx: readFileSync(pfxP), pass: 'smoke' }, {
    isLocalApiPath: (p) => p.startsWith('/__wx_channels_api/'),
    handleLocalApi: (req, res) => handleLocalApi(ctx, req, res),
    interceptResponse: () => null,
  })
  await mitm.start()
  const mitmPort = mitm['server']?.address()?.port ?? 0

  // Request through the MITM'd host tunnel (local API lives on this path).
  function mitmRequest(path, method, body, auth) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: mitmPort, method: 'CONNECT', path: 'channels.weixin.qq.com:443' })
      req.on('connect', (res, socket) => {
        const tlsSock = tls.connect({ socket, servername: 'channels.weixin.qq.com', rejectUnauthorized: false }, () => {
          const payload = body ? JSON.stringify(body) : null
          const CRLF = '\r\n'
          const head = [
            `${method} ${path} HTTP/1.1`,
            'Host: channels.weixin.qq.com',
            'Connection: close',
            ...(payload ? ['Content-Type: application/json', `Content-Length: ${Buffer.byteLength(payload)}`] : []),
            ...(auth ? [`X-Local-Auth: ${auth}`] : []),
            '',
            payload ?? '',
          ].join(CRLF)
          tlsSock.write(head)
          let buf = ''
          tlsSock.on('data', (d) => (buf += d.toString()))
          tlsSock.on('end', () => resolve(buf))
          tlsSock.on('error', reject)
        })
        tlsSock.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    })
  }

  // Plain passthrough tunnel (tunnelConnect path) to the fake upstream.
  function tunneledRequest() {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: mitmPort, method: 'CONNECT', path: `127.0.0.1:${upstreamPort}` })
      req.on('connect', (res, socket) => {
        const tlsSock = tls.connect({ socket, rejectUnauthorized: false }, () => {
          tlsSock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nConnection: close\r\n\r\n`)
          let buf = ''
          tlsSock.on('data', (d) => (buf += d.toString()))
          tlsSock.on('end', () => resolve(buf))
          tlsSock.on('error', reject)
        })
        tlsSock.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    })
  }

  // Token enforcement: missing/wrong X-Local-Auth -> 401.
  const saveBody = {
    username: 'v2_ok@finder', author: '测试作者',
    videos: [{ id: 'oid-smoke-1', title: '冒烟视频', url: 'https://example.com/v.mp4', key: '123456', createtime: 1727000000, nickname: '测试作者' }],
  }
  const unauth = await mitmRequest('/__wx_channels_api/save_video_list', 'POST', saveBody)
  check('local api rejects missing X-Local-Auth with 401', /^HTTP\/1\.1 401/.test(unauth), unauth.slice(0, 120))
  const badAuth = await mitmRequest('/__wx_channels_api/batch_progress', 'GET', null, 'wrong-token')
  check('local api rejects wrong token with 401', /^HTTP\/1\.1 401/.test(badAuth), badAuth.slice(0, 120))

  const r1 = await mitmRequest('/__wx_channels_api/save_video_list', 'POST', saveBody, 'secret-token')
  check('local api save_video_list through MITM tunnel (with token)', /"code":0/.test(r1) && /success:1/.test(r1), r1.slice(0, 200))

  const r2 = await mitmRequest('/__wx_channels_api/batch_progress', 'GET', null, 'secret-token')
  check('local api batch_progress through MITM tunnel (with token)', /"code":0/.test(r2) && /"running":false/.test(r2), r2.slice(0, 200))

  // Static page libs stay unauthenticated (<script src> cannot send headers).
  const lib = await mitmRequest('/FileSaver.min.js', 'GET')
  check('static page lib served without auth (not 401)', !/^HTTP\/1\.1 401/.test(lib), lib.slice(0, 120))

  await mitmRequest('/__wx_channels_api/save_video_list', 'POST', {
    username: 'v2_other@finder', author: '别人',
    videos: [{ id: 'oid-smoke-2', url: 'https://example.com/x.mp4' }],
  }, 'secret-token')
  const cat = store.listCatalog()
  check('watchlist gate filters non-watched author', cat.some((c) => c.object_id === 'oid-smoke-1') && !cat.some((c) => c.object_id === 'oid-smoke-2'), JSON.stringify(cat.map((c) => c.object_id)))

  const r3 = await tunneledRequest()
  check('non-MITM host tunneled through to upstream', /upstream-ok/.test(r3) && upstreamHits === 1, `hits=${upstreamHits} ${r3.slice(0, 120)}`)

  mitm.stop()
  upstream.close()

  const inj = new Injector()
  const html = inj.rewriteHtml('channels.weixin.qq.com', '/web/pages/profile', '<html><head></head><body></body></html>', { token: 'T', version: 'v' })
  check('rewriteHtml injects scripts on target page', html !== null && html.includes('window.__WX_LOCAL_TOKEN__="T"') && html.includes('save_video_list'))
  check('rewriteHtml skips non-target page', inj.rewriteHtml('channels.weixin.qq.com', '/web/pages/other', '<html><head></head></html>', { token: 'T', version: 'v' }) === null)

  // 1) Go-original strict shape: body starts with `return`, methods separated by `}async`.
  const strictBundle = 'class A{async finderUserPage(a,b){return await this.api(a,b)}async finderLiveUserPage(c){return await this.api2(c)}async nextFn(d){return 4}}'
  const strict = inj.patchJavaScript('/t/wx_fed/finder/web/web-finder/res/js/virtual_svg-icons-register.js', strictBundle)
  const strictParses = (() => { try { new Function(strict.content); return true } catch { return false } })()
  check('strict shape: finderUserPage patched + emits UserFeedsLoaded', strict.content.includes('UserFeedsLoaded') && strict.content.includes('async nextFn(d){return 4}'), strict.content.slice(0, 400))
  check('strict shape: patched bundle is valid JS', strictParses)
  check('strict shape: finderUserPage wrapped exactly once (no double patch)', (strict.content.match(/await\(async\(\)=>\{return/g) ?? []).length === 2, strict.content.slice(0, 400))

  // 2) Loose shape: body does NOT start with `return` (old port produced `return var ...` = syntax error).
  const looseBundle = 'class A{async finderUserPage(a,b){var x=1;return {data:{object:{id:1}}}}async nextFn(c){return 2}}'
  const loose = inj.patchJavaScript('/t/wx_fed/finder/web/web-finder/res/js/virtual_svg-icons-register.js', looseBundle)
  const looseParses = (() => { try { new Function(loose.content); return true } catch { return false } })()
  check('loose shape: patched + emits UserFeedsLoaded', loose.content.includes('UserFeedsLoaded') && loose.content.includes('async nextFn(c){return 2}'), loose.content.slice(0, 400))
  check('loose shape: patched bundle is valid JS', looseParses, loose.content.slice(0, 400))

  // 3) Whitespace shape: `}  async` between methods (old indexOf('}async') missed this entirely).
  const wsBundle = 'class A{  async finderUserPage(a){ return await this.api(a) }  async nextFn(c){ return 2 } }'
  const ws = inj.patchJavaScript('/t/wx_fed/finder/web/web-finder/res/js/virtual_svg-icons-register.js', wsBundle)
  const wsParses = (() => { try { new Function(ws.content); return true } catch { return false } })()
  check('whitespace shape: patched (Go-style \\s* tail)', ws.content.includes('UserFeedsLoaded'), ws.content.slice(0, 400))
  check('whitespace shape: patched bundle is valid JS', wsParses, ws.content.slice(0, 400))

  const pub = inj.patchJavaScript('/t/wx_fed/finder/web/web-finder/res/js/index.publish.js', 'this.sourceBuffer.appendBuffer(h),if(f.cmd===re.MAIN_THREAD_CMD.AUTO_CUT)')
  check('patchJavaScript patches index.publish buffer hook', pub.handled && pub.content.includes('__wx_channels_store__'))

  const { decryptBuffer } = await import('../lib/core/isaac64.js')
  const data = Buffer.from((() => { const a = new Uint8Array(64 * 1024); for (let i = 0; i < a.length; i++) a[i] = i & 0xff; return a })())
  const enc = Buffer.from(data); decryptBuffer(enc, 32768, 1789386502n)
  check('isaac64 keystream changes prefix only', !enc.slice(0, 100).equals(data.slice(0, 100)) && enc.slice(40000).equals(data.slice(40000)))
  const dec = Buffer.from(enc); decryptBuffer(dec, 32768, 1789386502n)
  check('isaac64 XOR round-trip restores original', dec.equals(data))
  let edgeOk = true
  try { const b = Buffer.alloc(16); decryptBuffer(b, 16, 18446744073709551615n) } catch { edgeOk = false }
  check('isaac64 handles max uint64 key', edgeOk)

  store.close()
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\nPASS ${PASS.length}:`)
for (const p of PASS) console.log('  ✓', p)
if (FAIL.length) {
  console.log(`FAIL ${FAIL.length}:`)
  for (const f of FAIL) console.log('  ✗', f)
  process.exit(1)
}
console.log('ALL SMOKE CHECKS PASSED')
process.exit(0)
