/**
 * Combined HTTP server: serves the visualizer UI and streams events via SSE.
 * Reuses the extension's hook server, transcript parser, and session watcher.
 */
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { exec, execFile } from 'child_process'

import { createRelay } from '../../scripts/relay'
import { createTelemetryClient } from '../../scripts/telemetry'
import { serveStatic } from './static'
import { codeLogin, deniedAs, deviceAsks, lanCookie, lanFor, lanGate, lanHosts, liveToken, macNames, phoneSecret, proxyHub, signInPage, tellWindows, uaSummary, waitPage, windows, type Lan } from './hub-proxy'
import { ipv4s } from '../../extension/src/hub/lan'

interface ServerOptions {
  port: number
  openBrowser: boolean
  workspace: string
  verbose?: boolean
  lan?: boolean
}

const WEB_FILE = path.join(os.homedir(), '.claude', 'switchboard', 'web.url')
// Marks a --lan app and its port; the VS Code panel builds the phone links from the current addresses and phone.secret.
const LAN_FILE = path.join(os.homedir(), '.claude', 'switchboard', 'web.lan')

export async function startServer(options: ServerOptions) {
  const { port, openBrowser, workspace } = options

  const configDir = path.join(os.homedir(), '.agent-flow')
  const telemetry = createTelemetryClient({
    logDir: path.join(configDir, 'telemetry'),
    installIdPath: path.join(configDir, 'installation-id'),
  })
  await telemetry.init()

  const relay = await createRelay({ workspace, verbose: options.verbose, telemetry })

  const secret = options.lan ? phoneSecret(path.join(os.homedir(), '.claude', 'switchboard', 'phone.secret')) : ''

  const checkCode = codeLogin()
  const login = (res: http.ServerResponse, lan: Lan) =>
    res.writeHead(302, { Location: '/', 'Set-Cookie': `${lanCookie(port)}=${lan.secret}; HttpOnly; SameSite=Strict; Path=/`, 'Cache-Control': 'no-store' }).end()
  const html = (res: http.ServerResponse, status: number, body: string) =>
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" }).end(body)
  const page = (res: http.ServerResponse, status: number, note?: string) => html(res, status, signInPage(note))
  const readBody = async (req: http.IncomingMessage, max: number) => {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > max) return undefined
    }
    return body
  }
  const typedCode = async (req: http.IncomingMessage, res: http.ServerResponse, lan: Lan) => {
    const body = await readBody(req, 256)
    if (body === undefined) { res.writeHead(413).end(); return }
    const r = checkCode((new URLSearchParams(body).get('code') ?? '').replace(/\s/g, ''), lan.secret)
    if (r === 'ok') login(res, lan)
    else if (r === 'wrong') page(res, 401, 'Wrong code')
    else page(res, 429, 'Too many wrong codes. Sign-in is locked for a few minutes; scan the QR code instead.')
  }

  // Ask the Mac: the device waits on /device/wait?id=, VS Code answers on loopback /device/answer.
  const asks = deviceAsks()
  const askMac = (req: http.IncomingMessage, res: http.ServerResponse, lan: Lan) => {
    req.resume()
    const a = asks.ask({ ip: (req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''), ua: uaSummary(req.headers['user-agent']), host: String(req.headers.host), network: lanHosts([lan.host]).tailscale ? 'Tailscale' : 'Wi-Fi' })
    if (!a) { page(res, 429, 'Too many devices are waiting. Try again in a few minutes, or use the code.'); return }
    void tellWindows({ id: a.id, ip: a.ip, ua: a.ua, network: a.network, port })
    res.writeHead(303, { Location: `/device/wait?id=${a.id}`, 'Cache-Control': 'no-store' }).end()
  }
  const waitMac = (req: http.IncomingMessage, res: http.ServerResponse, lan: Lan) => {
    const id = new URL(req.url ?? '/', 'http://x').searchParams.get('id') ?? ''
    const st = asks.state(id)
    if (st === 'pending') html(res, 200, waitPage(id))
    else if (st === 'allowed') login(res, lan)
    else if (st === 'denied') page(res, 403, 'The Mac said no.')
    else page(res, 401, 'No answer from the Mac. Ask again, or use the code.')
  }
  const answerMac = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const body = await readBody(req, 1024)
    let b: { id?: unknown; allow?: unknown; token?: unknown } = {}
    try { b = JSON.parse(body ?? '') } catch { /* refused below */ }
    if (typeof b.id !== 'string' || typeof b.allow !== 'boolean') { res.writeHead(400).end(); return }
    if (!liveToken(await windows(), b.token)) { res.writeHead(403).end(); return }
    if (!asks.answer(b.id, b.allow)) { res.writeHead(409).end(); return }
    void tellWindows({ id: b.id, done: true })
    res.writeHead(204).end()
  }

  // lan: undefined for loopback, else the address the request came in on; only that Host is accepted.
  const handle = (lan: Lan | undefined, req: http.IncomingMessage, res: http.ServerResponse) => {
    const gate = lanGate(req.headers, req.url ?? '/', port, lan)
    if (gate === 'deny') {
      const as = deniedAs(req.method, req.headers, req.url ?? '/', port, lan!)
      if (as === 'page') page(res, 401)
      else if (as === 'login') typedCode(req, res, lan!).catch(() => { if (!res.headersSent) res.writeHead(400); res.end() })
      else if (as === 'device') askMac(req, res, lan!)
      else if (as === 'wait') waitMac(req, res, lan!)
      else res.writeHead(403).end()
      return
    }
    if (gate === 'login') { login(res, lan!); return }

    // Loopback only: a signed-in phone passes the gate but must not answer for the Mac.
    if (req.method === 'POST' && req.url === '/device/answer') {
      if (lan) res.writeHead(403).end()
      else answerMac(req, res).catch(() => { if (!res.headersSent) res.writeHead(400); res.end() })
      return
    }

    // SSE endpoint
    if (req.url === '/events') {
      return relay.handleSSE(req, res)
    }

    // The hub, through a VS Code window's hook server
    if (req.url?.startsWith('/hub/')) {
      // A client dropping mid-body rejects here; uncaught, that exits the app.
      proxyHub(req, res, port, workspace, lan).catch(() => { if (!res.headersSent) res.writeHead(400); res.end() })
      return
    }

    // Static files (UI)
    if (req.method === 'GET') {
      return serveStatic(req, res)
    }

    res.writeHead(404)
    res.end('Not found')
  }
  // One bad request must not take the app down: with --lan the socket is open to anyone on the network.
  // Kicks off the first read now; each call after reuses it and rereads in the background every few minutes.
  if (options.lan) macNames()
  const names = () => Object.values(macNames()).filter((n): n is string => !!n)
  const server = http.createServer((req, res) => {
    try { handle(options.lan ? lanFor(req.socket.localAddress, secret, names()) : undefined, req, res) } catch { if (!res.headersSent) res.writeHead(400); res.end() }
  })
  // 0.0.0.0 covers 127.0.0.1 too, and any address this Mac picks up later.
  const host = options.lan ? '0.0.0.0' : '127.0.0.1'
  const up = await new Promise<boolean>(done => {
    server.once('error', err => { console.log(`Could not listen on ${host}:${port}: ${err.message}`); done(false) })
    server.listen(port, host, () => done(true))
  })
  if (!up) {
    relay.dispose()
    await telemetry.dispose()
    process.exit(1)
  }

  const url = `http://127.0.0.1:${port}`
  // Switchboard's browser link reads this; any port works.
  try { fs.mkdirSync(path.dirname(WEB_FILE), { recursive: true }); fs.writeFileSync(WEB_FILE, url) } catch { /* link falls back to 3001 */ }
  // Written only once the socket listens, so a failed start never leaves a phone link behind.
  const lanMark = `http://0.0.0.0:${port}`
  if (options.lan) {
    try { fs.writeFileSync(LAN_FILE, lanMark) } catch { /* no phone link */ }
    const { wifi, tailscale } = lanHosts(ipv4s())
    if (wifi) console.log(`Phone access on http://${wifi}:${port} (Wi-Fi; secret link in the Switchboard panel)`)
    if (tailscale) console.log(`Phone access on http://${tailscale}:${port} (Tailscale; secret link in the Switchboard panel)`)
    if (!wifi && !tailscale) console.log('No Wi-Fi or Tailscale address yet; the phone links appear once there is one')
  }
  console.log(`Server running at ${url}`)
  console.log('Waiting for agent events...\n')
  if (openBrowser) openURL(url)

  // Cleanup on exit. Idempotent — repeat signals (Ctrl+C spam, SIGTERM+SIGHUP,
  // etc.) would otherwise emit duplicate session_end events and race the
  // telemetry sync loop against itself.
  let shuttingDown = false
  function cleanup() {
    if (shuttingDown) return
    shuttingDown = true
    try { if (fs.readFileSync(WEB_FILE, 'utf8') === `http://127.0.0.1:${port}`) fs.unlinkSync(WEB_FILE) } catch { /* gone */ }
    try { if (options.lan && fs.readFileSync(LAN_FILE, 'utf8') === lanMark) fs.unlinkSync(LAN_FILE) } catch { /* gone */ }
    server.close()
    relay.dispose()
    void telemetry.dispose().finally(() => process.exit(0))
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  // SIGHUP fires when the controlling terminal closes (SSH session drops, tmux
  // pane killed). Without a handler, Node's default behavior is to terminate
  // without running cleanup — so session_end never flushes.
  process.on('SIGHUP', cleanup)
}

function openURL(url: string) {
  if (process.platform === 'win32') {
    // 'start' is a shell builtin on Windows — must use exec, not execFile
    exec(`start "" "${url}"`)
  } else {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
    execFile(cmd, [url], () => {})
  }
}
