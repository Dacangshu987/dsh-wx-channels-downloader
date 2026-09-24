// Build the browser half with esbuild (server half is emitted by tsc).
// lib/index.js (server) comes from tsc; lib/client.js (browser) is this bundle.
//
// The web client loads plugin halves through window.__ModuleLoader__, so the
// bundle must be emitted in the dsh client-module format: a CJS body (react
// stays external and arrives through the factory's require) wrapped in
// `__ModuleLoader__.load({ id, factory })`. A bare ESM bundle imports fine
// under Node but the assembly cannot register it — the plugin shows up as
// "import failed" at web boot.
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const watch = process.argv.includes('--watch')

mkdirSync(join(root, 'lib'), { recursive: true })

await build({
  entryPoints: [join(root, 'src/client/index.tsx')],
  bundle: true,
  outfile: join(root, 'lib/client.js'),
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'info',
  banner: {
    js: [
      'window.__ModuleLoader__.load({',
      '\tid: "dsh-wx-channels-downloader",',
      '\tfactory: (require) => {',
      '\t\tvar module = { exports: {} };',
      '\t\tvar exports = module.exports;',
      '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
      '',
    ].join('\n'),
  },
  footer: {
    js: ['\t\treturn module.exports;', '\t}', '});'].join('\n'),
  },
  ...(watch ? { watch: true } : {}),
})
