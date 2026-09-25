// Copy the vendored injection scripts (from the nobiyou/wx_channel reference
// checkout, MIT licensed, attribution kept in ASSETS_README) into this
// plugin's own assets/inject so the package is self-contained at runtime.
// The vendored checkout lives at <repo>/tools/nobiyou-src/internal/assets/inject
// (and its lib/ subfolder) by the user's setup; see ASSETS_README.md.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const repoRoot = resolve(pluginRoot, '..')

const candidates = [
  join(repoRoot, 'tools', 'nobiyou-src', 'internal', 'assets', 'inject'),
  join(repoRoot, '.ref', 'wx_channel', 'internal', 'assets', 'inject'),
]
const srcDir = candidates.find((p) => existsSync(p))
if (!srcDir) {
  // The vendored checkout is an upstream-refresh convenience, not a build
  // requirement: assets/inject is committed with the repo.
  console.warn('[copy-assets] vendored inject sources not found under:', candidates)
  console.warn('[copy-assets] keeping the committed assets/inject as-is; continuing build')
  process.exit(0)
}

const destDir = join(pluginRoot, 'assets', 'inject')
mkdirSync(destDir, { recursive: true })
mkdirSync(join(destDir, 'lib'), { recursive: true })

function copyTree(from, to) {
  for (const name of readdirSync(from)) {
    const s = statSync(join(from, name))
    if (name === 'dist') continue
    if (s.isDirectory()) {
      // flatten lib/*.js into assets/inject/lib
      mkdirSync(join(to, name), { recursive: true })
      copyTree(join(from, name), join(to, name))
    } else {
      cpSync(join(from, name), join(to, name))
    }
  }
}

copyTree(srcDir, destDir)

// Sidecar (Go) embeds the same page scripts for process-level injection.
const sideAssets = join(pluginRoot, 'sidecar', 'assets', 'inject')
mkdirSync(sideAssets, { recursive: true })
cpSync(destDir, sideAssets, { recursive: true })
console.log('[copy-assets] sidecar inject assets synced ->', sideAssets)

// Page libs (FileSaver / jszip) served same-origin from assets/lib
const srcLib = join(repoRoot, 'tools', 'nobiyou-src', 'internal', 'assets', 'lib')
if (existsSync(srcLib)) {
  const destLib = join(pluginRoot, 'assets', 'lib')
  mkdirSync(destLib, { recursive: true })
  copyTree(srcLib, destLib)
}

writeFileSync(
  join(pluginRoot, 'assets', 'ASSETS_README.md'),
  [
    '# Vendored injection assets',
    '',
    'These page-side scripts are copied from **nobiyou/wx_channel** (MIT License,',
    'https://github.com/nobiyou/wx_channel) — the reference implementation this plugin',
    're-implements. They run inside WeChat\'s channels pages after the local proxy injects',
    'them (HTML injection on channels.weixin.qq.com/web/pages/* + JS bundle patches).',
    'Only the scripts needed by this plugin are kept; service side is native TypeScript.',
    '',
    `Source directory: ${srcDir}`,
    '',
  ].join('\n'),
)

console.log('[copy-assets] injection assets copied from', srcDir, '->', destDir)