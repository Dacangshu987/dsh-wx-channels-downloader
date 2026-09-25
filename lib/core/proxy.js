/**
 * Zero-dependency HTTPS MITM proxy (pure node:http/net/tls).
 * - CONNECT to SNI hosts in the mitm set -> TLS upgrade with our leaf cert,
 *   inner HTTP parsed and routed (local API / intercepted responses).
 * - CONNECT to anything else -> plain tunnel (only channels.weixin.qq.com
 *   is MITM'd; video CDNs stay tunneled so their transport is untouched).
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
// The Go reference has no size cap on intercepted bodies; keep the budget
// generous so large finder bundles still get patched.
const MAX_INTERCEPT_BYTES = 32 * 1024 * 1024;
export class MitmServer {
    port;
    mitmHosts;
    leaf;
    hooks;
    server = null;
    secureContext = null;
    constructor(port, mitmHosts, leaf, hooks) {
        this.port = port;
        this.mitmHosts = mitmHosts;
        this.leaf = leaf;
        this.hooks = hooks;
    }
    start() {
        this.secureContext = tls.createSecureContext({ pfx: this.leaf.pfx, passphrase: this.leaf.pass });
        const server = http.createServer((req, res) => {
            void this.handlePlainHttp(req, res);
        });
        server.on('connect', (req, clientSocket, head) => {
            void this.handleConnect(req, clientSocket, head);
        });
        server.on('clientError', (_err, socket) => {
            try {
                socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
            }
            catch {
                // ignore
            }
        });
        this.server = server;
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(this.port, '127.0.0.1', () => {
                server.removeListener('error', reject);
                resolve();
            });
        });
    }
    stop() {
        const server = this.server;
        this.server = null;
        if (!server)
            return Promise.resolve();
        return new Promise((resolve) => {
            server.close(() => resolve());
            // force-close lingering sockets
            server.closeAllConnections?.();
            setTimeout(resolve, 500).unref();
        });
    }
    handleConnect(req, clientSocket, head) {
        const [host, portStr] = (req.url ?? '').split(':');
        const port = Number(portStr) || 443;
        if (!host) {
            clientSocket.destroy();
            return;
        }
        if (this.mitmHosts.has(host)) {
            this.mitmConnect(clientSocket, host, head);
        }
        else {
            this.tunnelConnect(clientSocket, host, port, head);
        }
    }
    mitmConnect(clientSocket, host, head) {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const tlsSocket = new tls.TLSSocket(clientSocket, {
            isServer: true,
            secureContext: this.secureContext,
        });
        tlsSocket.on('error', () => {
            try {
                tlsSocket.destroy();
            }
            catch {
                // ignore
            }
        });
        if (head.length)
            tlsSocket.unshift(head);
        const inner = http.createServer();
        inner.on('request', (req, res) => {
            void this.handleInnerRequest(req, res).catch(() => {
                try {
                    res.writeHead(502).end();
                }
                catch {
                    // ignore
                }
            });
        });
        inner.on('clientError', (_err, sock) => {
            try {
                sock.end();
            }
            catch {
                // ignore
            }
        });
        inner.listen(0, '127.0.0.1', () => {
            inner.emit('connection', tlsSocket);
            // The inner server is only used as a connection sink; stop listening
            // immediately or every CONNECT leaks an ephemeral listener for the
            // process lifetime.
            inner.close();
        });
    }
    async handleInnerRequest(req, res) {
        const pathname = (req.url ?? '/').split('?')[0] ?? '/';
        if (this.hooks.isLocalApiPath(pathname)) {
            const handled = await this.hooks.handleLocalApi(req, res);
            if (handled)
                return;
        }
        if (!this.mitmHosts.has(hostOf(req))) {
            // The CONNECT target was in the MITM set, so a request whose Host is
            // outside it is unexpected (misbehaving client). Refuse rather than
            // forward — piping raw bytes to an arbitrary host would be wrong.
            try {
                res.writeHead(421).end();
            }
            catch {
                // ignore
            }
            return;
        }
        await this.forward(req, res);
    }
    /** Forward one inner request to the real origin with response interception. */
    forward(req, res) {
        return new Promise((resolve) => {
            const pathname = (req.url ?? '/').split('?')[0] ?? '/';
            const headers = cleanHeaders(req.headers);
            const outReq = https.request({
                host: hostOf(req) || 'channels.weixin.qq.com',
                port: 443,
                method: req.method,
                path: req.url || '/',
                headers,
                timeout: 30000,
            }, (outRes) => {
                const contentType = String(outRes.headers['content-type'] ?? '');
                const ct = contentType.toLowerCase();
                const wantIntercept = ct.includes('text/html') || ct.includes('javascript') || ct.includes('ecmascript');
                const declared = Number(outRes.headers['content-length'] ?? 0);
                if (!wantIntercept || (declared > 0 && declared > MAX_INTERCEPT_BYTES)) {
                    if (wantIntercept && declared > MAX_INTERCEPT_BYTES) {
                        this.hooks.onInterceptSkip?.(pathname, declared);
                    }
                    res.writeHead(outRes.statusCode ?? 502, outRes.headers);
                    outRes.pipe(res);
                    return resolve();
                }
                const chunks = [];
                let size = 0;
                let overflowed = false;
                outRes.on('data', (c) => {
                    size += c.length;
                    if (size > MAX_INTERCEPT_BYTES) {
                        // Fall back to streaming passthrough, flushing what we buffered.
                        if (!overflowed) {
                            overflowed = true;
                            const h = { ...outRes.headers };
                            delete h['content-length'];
                            res.writeHead(outRes.statusCode ?? 502, h);
                            for (const b of chunks)
                                res.write(b);
                            chunks.length = 0;
                            outRes.on('data', (d) => res.write(d));
                            outRes.on('end', () => res.end());
                            outRes.on('error', () => res.destroy());
                        }
                        return;
                    }
                    chunks.push(c);
                });
                outRes.on('end', () => {
                    const body = Buffer.concat(chunks);
                    const rewritten = this.hooks.interceptResponse(hostOf(req) || '', pathname, contentType, body);
                    const final = rewritten ?? body;
                    const outHeaders = { ...outRes.headers };
                    outHeaders['content-length'] = final.length;
                    res.writeHead(outRes.statusCode ?? 502, outHeaders);
                    res.end(final);
                    resolve();
                });
                outRes.on('error', () => resolve());
            });
            outReq.on('timeout', () => outReq.destroy(new Error('timeout')));
            outReq.on('error', () => {
                try {
                    res.writeHead(502).end('upstream error');
                }
                catch {
                    // ignore
                }
                resolve();
            });
            req.pipe(outReq);
        });
    }
    tunnelConnect(clientSocket, host, port, head) {
        const upstream = net.connect(port, host);
        upstream.once('connect', () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length)
                upstream.write(head);
            clientSocket.pipe(upstream);
            upstream.pipe(clientSocket);
        });
        upstream.on('error', () => {
            try {
                clientSocket.end();
            }
            catch {
                // ignore
            }
        });
        clientSocket.on('error', () => {
            try {
                upstream.destroy();
            }
            catch {
                // ignore
            }
        });
    }
    handlePlainHttp(req, res) {
        // Absolute-form http proxy requests (rare; e.g. http://channels... no).
        res.writeHead(403).end();
    }
}
function hostOf(req) {
    const h = req.headers.host;
    if (!h)
        return '';
    const m = /^([^:]+)/.exec(h);
    return m ? m[1].toLowerCase() : h.toLowerCase();
}
/** Strip hop-by-hop / proxy headers before replaying upstream. */
function cleanHeaders(headers) {
    const out = {};
    const skip = new Set(['proxy-connection', 'connection', 'keep-alive', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'accept-encoding']);
    for (const [k, v] of Object.entries(headers)) {
        if (skip.has(k.toLowerCase()))
            continue;
        if (k.toLowerCase() === 'host')
            continue;
        if (v !== undefined)
            out[k] = v;
    }
    return out;
}
//# sourceMappingURL=proxy.js.map