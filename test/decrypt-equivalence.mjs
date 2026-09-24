// Equivalence test: my ported ISAAC64 decrypt (plugin lib/core/isaac64.js)
// must produce byte-identical keystream to the wxdown Electron prototype's
// verified sphDecrypt.js (proven against real WeChat Channels files in P0).
// node test/decrypt-equivalence.mjs
import { createRequire } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = process.cwd()

const oldSph = require(fileURLToPath(pathToFileURL(root + '/dist/main/main/services/sphDecrypt.js')))
const { decryptBuffer: mine } = await import(pathToFileURL(root + '/dsh-wx-channels-downloader/lib/core/isaac64.js').href)

const keys = [1n, 42n, 0x9e3779b97f4a7c13n, 1789386502n, 15010461926532980184n]
let failures = 0
for (const key of keys) {
  const data = randomBytes(200 * 1024) // 200KB > 128KB prefix
  const a = Buffer.from(data)
  const b = Buffer.from(data)
  const oldBuf = Buffer.from(data)
  const myBuf = Buffer.from(data)
  oldSph.decryptBuffer(oldBuf, 131072, key)
  mine(myBuf, 131072, key)
  const same = oldBuf.equals(myBuf)
  const aHash = createHash('sha256').update(oldBuf).digest('hex').slice(0, 16)
  const bHash = createHash('sha256').update(myBuf).digest('hex').slice(0, 16)
  console.log(`key=${key} len=200KB identical=${same} oldsha=${aHash} mysha=${bHash}`)
  if (!same) failures++
}
console.log(failures === 0 ? 'PASS: keystream identical across all keys' : `FAIL: ${failures} mismatches`)
process.exit(failures === 0 ? 0 : 1)