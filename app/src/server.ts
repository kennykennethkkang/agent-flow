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
import { lanCookie, lanGate, lanHosts, phoneSecret, proxyHub, type Lan } from './hub-proxy'

interface ServerOptions {
  port: number
  openBrowser: boolean
  workspace: string
  verbose?: boolean
  lan?: boolean
}

const WEB_FILE = path.join(os.homedir(), '.claude', 'switchboard', 'web.url')
// The phone link with its secret; only the VS Code panel reads it, for the QR.
const LAN_FILE = path.join(os.homedir(), '.claude', 'switchboard', 'web.lan')

const ipv4s = () => Object.values(os.networkInterfaces()).flat().flatMap(i => (i && i.family === 'IPv4' && !i.internal ? [i.address] : []))

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
  const { wifi, tailscale } = options.lan ? lanHosts(ipv4s()) : {}
  // One socket per address, Tailscale first: the phone link prefers it.
  const lans: Lan[] = [tailscale, wifi].filter((h): h is string => !!h).map(host => ({ host, secret }))

  // lan: the socket the request came in on, undefined for loopback. Each socket accepts only its own Host.
  const handle = (lan: Lan | undefined) => (req: http.IncomingMessage, res: http.ServerResponse) => {
    const gate = lanGate(req.headers, req.url ?? '/', port, lan)
    if (gate === 'deny') { res.writeHead(403).end(); return }
    if (gate === 'login') {
      res.writeHead(302, { Location: '/', 'Set-Cookie': `${lanCookie(port)}=${lan!.secret}; HttpOnly; SameSite=Strict; Path=/`, 'Cache-Control': 'no-store' }).end()
      return
    }

    // SSE endpoint
    if (req.url === '/events') {
      return relay.handleSSE(req, res)
    }

    // The hub, through a VS Code window's hook server
    if (req.url?.startsWith('/hub/')) {
      // A client dropping mid-body rejects here; uncaught, that exits the app.
      proxyHub(req, res, port, workspace, lan?.host).catch(() => { if (!res.headersSent) res.writeHead(400); res.end() })
      return
    }

    // Static files (UI)
    if (req.method === 'GET') {
      return serveStatic(req, res)
    }

    res.writeHead(404)
    res.end('Not found')
  }
  // One bad request must not take the app down: the LAN sockets are open to anyone on the network.
  const safe = (lan: Lan | undefined) => (req: http.IncomingMessage, res: http.ServerResponse) => {
    try { handle(lan)(req, res) } catch { if (!res.headersSent) res.writeHead(400); res.end() }
  }
  const server = http.createServer(safe(undefined))
  const lanServers = lans.map(lan => ({ lan, server: http.createServer(safe(lan)) }))
  if (options.lan && !lans.length) console.log('No Wi-Fi or Tailscale address found; phone access is off')
  const listen = (s: http.Server, host: string) => new Promise<boolean>(done => {
    s.once('error', err => { console.log(`Could not listen on ${host}:${port}: ${err.message}`); done(false) })
    s.listen(port, host, () => done(true))
  })
  const [up, ...lanUp] = await Promise.all([listen(server, '127.0.0.1'), ...lanServers.map(l => listen(l.server, l.lan.host))])
  if (!up) {
    for (const l of lanServers) l.server.close()
    relay.dispose()
    await telemetry.dispose()
    process.exit(1)
  }

  const url = `http://127.0.0.1:${port}`
  // Switchboard's browser link reads this; any port works.
  try { fs.mkdirSync(path.dirname(WEB_FILE), { recursive: true }); fs.writeFileSync(WEB_FILE, url) } catch { /* link falls back to 3001 */ }
  // Written only once its socket listens, so a failed start never leaves a phone link behind.
  const phone = lans.find((_, i) => lanUp[i])
  if (phone) {
    // Removed first so the 0600 mode applies to a fresh file.
    try {
      fs.rmSync(LAN_FILE, { force: true })
      fs.writeFileSync(LAN_FILE, `http://${phone.host}:${port}/?k=${secret}`, { mode: 0o600 })
    } catch { /* no phone link */ }
    lans.forEach((l, i) => { if (lanUp[i]) console.log(`Phone access on http://${l.host}:${port} (${l.host === tailscale ? 'Tailscale' : 'Wi-Fi'}; secret link in the Switchboard panel)`) })
  } else if (lanServers.length) {
    console.log('Phone access is off')
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
    try { if (secret && fs.readFileSync(LAN_FILE, 'utf8').includes(secret)) fs.unlinkSync(LAN_FILE) } catch { /* gone */ }
    server.close()
    for (const l of lanServers) l.server.close()
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
