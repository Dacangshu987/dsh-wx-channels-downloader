/**
 * Host half of the wx-channels-downloader plugin: starts the local MITM
 * proxy + capture/download pipeline and exposes the /wxchannels web API
 * (state / commands / SSE event stream) for the browser panel.
 * Browser half: src/client.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { Config, DEFAULT_CONFIG, WXCHANNELS_NAMESPACE, resolveConfig, type ConfigType } from './config.js'
import { WxChannelsService } from './core/service.js'
import { WEB_API_PREFIX, type ClientCommand, type ServerEvent } from './shared/protocol.js'

export const name = 'wx-channels-downloader'
export const inject = ['webServer']

export { Config, DEFAULT_CONFIG, WXCHANNELS_NAMESPACE, resolveConfig }
export type { ConfigType }

const mountedContexts = new WeakSet<Context>()

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size < 2 * 1024 * 1024) chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

function handleWebApi(svc: WxChannelsService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/'
    if (req.method === 'GET' && pathname === `${WEB_API_PREFIX}/state`) {
      sendJson(res, 200, {
        ok: true,
        ...svc.diagnostics(),
        catalog: svc.catalogJson(),
        catalogAll: svc.catalogJson(true),
        downloads: svc.downloadsJson(),
        logs: svc.recentLogs(),
        watchlist: svc.watchlistJson(),
        watchActive: svc.watchActive(),
      })
      return resolve()
    }
    if (req.method === 'POST' && pathname === `${WEB_API_PREFIX}/cmd`) {
      void (async () => {
        const raw = (await readJson(req)) as { command?: string; payload?: Record<string, unknown> }
        const cmd: ClientCommand | undefined = raw?.command as ClientCommand | undefined
        if (!cmd) {
          sendJson(res, 400, { ok: false, error: 'missing command' })
          return resolve()
        }
        const kind = typeof cmd === 'string' ? cmd : (cmd as { kind: string }).kind
        const payload = typeof cmd === 'string' ? raw?.payload ?? {} : (cmd as { payload?: Record<string, unknown> }).payload ?? {}
        const result = await svc.command(kind, payload)
        sendJson(res, result.ok ? 200 : 400, result)
        resolve()
      })()
      return
    }
    if (req.method === 'GET' && pathname === `${WEB_API_PREFIX}/events`) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write(': open\n\n')
      const send = (e: ServerEvent): void => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`)
      }
      const off = svc.hub.subscribe(send)
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n')
      }, 15000)
      res.on('close', () => {
        clearInterval(heartbeat)
        off()
      })
      return
    }
    sendJson(res, 404, { ok: false, error: 'not found' })
    resolve()
  })
}

/**
 * Mount the host half. Guarded against re-application on the same context
 * (reload/re-link) to avoid double proxy instances.
 */
export function apply(ctx: Context, config: ConfigType = { ...DEFAULT_CONFIG }): void {
  const cfg = resolveConfig(config)
  if (mountedContexts.has(ctx)) return
  mountedContexts.add(ctx)

  const svc = new WxChannelsService(cfg)
  // Do not block boot on cert/proxy setup; report failures over the hub.
  void svc.start().catch((err) => svc.hub.emitLog(`⚠️ 启动失败: ${(err as Error).message}`))
  ctx.effect(() => {
    mountedContexts.delete(ctx)
    return () => {
      void svc.stop().catch(() => {
        /* ignore */
      })
    }
  })

  const webserver = ctx.get('webServer')
  if (webserver === undefined) return
  try {
    webserver.register({
      kind: 'prefix',
      path: WEB_API_PREFIX,
      handler: (req: IncomingMessage, res: ServerResponse): Promise<void> => handleWebApi(svc, req, res),
    })
  } catch (err) {
    svc.hub.emitLog(`⚠️ 注册 /wxchannels API 失败: ${(err as Error).message}`)
  }
}