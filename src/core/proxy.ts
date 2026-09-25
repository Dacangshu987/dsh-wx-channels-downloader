/**
 * Zero-dependency HTTPS MITM proxy (pure node:http/net/tls).
 * - CONNECT to SNI hosts in the mitm set -> TLS upgrade with our leaf cert,
 *   inner HTTP parsed and routed (local API / intercepted responses).
 * - CONNECT to anything else -> plain tunnel (only channels.weixin.qq.com
 *   is MITM'd; video CDNs stay tunneled so their transport is untouched).
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import type { Duplex } from 'node:stream'

export interface MitmHooks {
  isLocalApiPath(pathname: string): boolean
  handleLocalApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> | boolean
  /** Return rewritten body (may change content-type) or null to pass through unchanged. */
  interceptResponse(host: string, pathname: string, contentType: string, body: Buffer): Buffer | null
  /** A JS/HTML response exceeded the intercept budget and is passed through unpatched. */
  onInterceptSkip?(pathname: string, declared: number): void
}

// The Go reference has no size cap on intercepted bodies; keep the budget
// generous so large finder bundles still get patched.
const MAX_INTERCEPT_BYTES = 32 * 1024 * 1024

export class MitmServer {
  private server: http.Server | null = null
  private secureContext: tls.SecureContext | null = null

  constructor(
    private readonly port: number,
    private readonly mitmHosts: Set<string>,
    private readonly leaf: { pfx: Buffer; pass: string },
    private readonly hooks: MitmHooks,
  ) {}

  start(): Promise<void> {
    this.secureContext = tls.createSecureContext({ pfx: this.leaf.pfx, passphrase: this.leaf.pass })
    const server = http.createServer((req, res) => {
      void this.handlePlainHttp(req, res)
    })
    server.on('connect', (req, clientSocket, head) => {
      void this.handleConnect(req, clientSocket, head)
    })
    server.on('clientError', (_err, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      } catch {
        // ignore
      }
    })
    this.server = server
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return Promise.resolve()
    return new Promise((resolve) => {
      server.close(() => resolve())
      // force-close lingering sockets
      server.closeAllConnections?.()
      setTimeout(resolve, 500).unref()
    })
  }

  private handleConnect(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const [host, portStr] = (req.url ?? '').split(':')
    const port = Number(portStr) || 443
    if (!host) {
      clientSocket.destroy()
      return
    }
    if (this.mitmHosts.has(host)) {
      this.mitmConnect(clientSocket, host, head)
    } else {
      this.tunnelConnect(clientSocket, host, port, head)
    }
  }

  private mitmConnect(clientSocket: Duplex, host: string, head: Buffer): void {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    const tlsSocket = new tls.TLSSocket(clientSocket as net.Socket, {
      isServer: true,
      secureContext: this.secureContext!,
    })
    tlsSocket.on('error', () => {
      try {
        tlsSocket.destroy()
      } catch {
        // ignore
      }
    })
    if (head.length) tlsSocket.unshift(head)

    const inner = http.createServer()
    inner.on('request', (req, res) => {
      void this.handleInnerRequest(req, res).catch(() => {
        try {
          res.writeHead(502).end()
        } catch {
          // ignore
        }
      })
    })
    inner.on('clientError', (_err, sock) => {
      try {
        sock.end()
      } catch {
        // ignore
      }
    })
    inner.listen(0, '127.0.0.1', () => {
      inner.emit('connection', tlsSocket)
      // The inner server is only used as a connection sink; stop listening
      // immediately or every CONNECT leaks an ephemeral listener for the
      // process lifetime.
      inner.close()
    })
  }

  private async handleInnerRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/'
    if (this.hooks.isLocalApiPath(pathname)) {
      const handled = await this.hooks.handleLocalApi(req, res)
      if (handled) return
    }
    if (!this.mitmHosts.has(hostOf(req))) {
      // The CONNECT target was in the MITM set, so a request whose Host is
      // outside it is unexpected (misbehaving client). Refuse rather than
      // forward — piping raw bytes to an arbitrary host would be wrong.
      try {
        res.writeHead(421).end()
      } catch {
        // ignore
      }
      return
    }
    await this.forward(req, res)
  }

  /** Forward one inner request to the real origin with response interception. */
  private forward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return new Promise((resolve) => {
      const pathname = (req.url ?? '/').split('?')[0] ?? '/'
      const headers = cleanHeaders(req.headers)
      const outReq = https.request(
        {
          host: hostOf(req) || 'channels.weixin.qq.com',
          port: 443,
          method: req.method,
          path: req.url || '/',
          headers,
          timeout: 30000,
        },
        (outRes) => {
          const contentType = String(outRes.headers['content-type'] ?? '')
          const ct = contentType.toLowerCase()
          const wantIntercept = ct.includes('text/html') || ct.includes('javascript') || ct.includes('ecmascript')
          const declared = Number(outRes.headers['content-length'] ?? 0)
          if (!wantIntercept || (declared > 0 && declared > MAX_INTERCEPT_BYTES)) {
            if (wantIntercept && declared > MAX_INTERCEPT_BYTES) {
              this.hooks.onInterceptSkip?.(pathname, declared)
            }
            res.writeHead(outRes.statusCode ?? 502, outRes.headers)
            outRes.pipe(res)
            return resolve()
          }
          const chunks: Buffer[] = []
          let size = 0
          let overflowed = false
          outRes.on('data', (c: Buffer) => {
            size += c.length
            if (size > MAX_INTERCEPT_BYTES) {
              // Fall back to streaming passthrough, flushing what we buffered.
              if (!overflowed) {
                overflowed = true
                const h: http.OutgoingHttpHeaders = { ...outRes.headers }
                delete h['content-length']
                res.writeHead(outRes.statusCode ?? 502, h)
                for (const b of chunks) res.write(b)
                chunks.length = 0
                outRes.on('data', (d: Buffer) => res.write(d))
                outRes.on('end', () => res.end())
                outRes.on('error', () => res.destroy())
              }
              return
            }
            chunks.push(c)
          })
          outRes.on('end', () => {
            const body = Buffer.concat(chunks)
            const rewritten = this.hooks.interceptResponse(hostOf(req) || '', pathname, contentType, body)
            const final = rewritten ?? body
            const outHeaders: http.OutgoingHttpHeaders = { ...outRes.headers }
            outHeaders['content-length'] = final.length
            res.writeHead(outRes.statusCode ?? 502, outHeaders)
            res.end(final)
            resolve()
          })
          outRes.on('error', () => resolve())
        },
      )
      outReq.on('timeout', () => outReq.destroy(new Error('timeout')))
      outReq.on('error', () => {
        try {
          res.writeHead(502).end('upstream error')
        } catch {
          // ignore
        }
        resolve()
      })
      req.pipe(outReq)
    })
  }

  private tunnelConnect(clientSocket: Duplex, host: string, port: number, head: Buffer): void {
    const upstream = net.connect(port, host)
    upstream.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      clientSocket.pipe(upstream)
      upstream.pipe(clientSocket)
    })
    upstream.on('error', () => {
      try {
        clientSocket.end()
      } catch {
        // ignore
      }
    })
    clientSocket.on('error', () => {
      try {
        upstream.destroy()
      } catch {
        // ignore
      }
    })
  }

  private handlePlainHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Absolute-form http proxy requests (rare; e.g. http://channels... no).
    res.writeHead(403).end()
  }
}

function hostOf(req: http.IncomingMessage): string {
  const h = req.headers.host
  if (!h) return ''
  const m = /^([^:]+)/.exec(h)
  return m ? m[1]!.toLowerCase() : h.toLowerCase()
}

/** Strip hop-by-hop / proxy headers before replaying upstream. */
function cleanHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  const skip = new Set(['proxy-connection', 'connection', 'keep-alive', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'accept-encoding'])
  for (const [k, v] of Object.entries(headers)) {
    if (skip.has(k.toLowerCase())) continue
    if (k.toLowerCase() === 'host') continue
    if (v !== undefined) out[k] = v
  }
  return out
}