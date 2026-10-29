/**
 * The standalone app's way to the hub: /hub/state and /hub/command are passed to
 * a VS Code window's hook server, found through ~/.claude/switchboard/*.json, with
 * the window's token added here so it never reaches the browser. Only the app's
 * own page may call it: a custom header (no form can send one), the same Origin
 * when there is one, and a loopback Host (no DNS rebinding). Called by server.ts.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'

type Win = { port: number; hubToken: string; workspace: string; mtimeMs: number; pid?: number }
const DIR = path.join(os.homedir(), '.claude', 'switchboard')
const MAX_BODY = 64 * 1024

// EPERM: the process exists but belongs to someone else.
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

const real = (p: string) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }

/** The newest live window whose workspace holds the app's folder, else the newest live one. A closed window can leave its file behind. */
export function pickWindow(files: Partial<Win>[], workspace: string, alive: (pid: number) => boolean = pidAlive): Win | undefined {
  const ok = files.filter((f): f is Win => typeof f.port === 'number' && typeof f.hubToken === 'string' && typeof f.workspace === 'string' && (typeof f.pid !== 'number' || alive(f.pid)))
  const newest = [...ok].sort((a, b) => b.mtimeMs - a.mtimeMs)
  const here = real(workspace)
  return newest.find(f => { const ws = real(f.workspace); return here === ws || here.startsWith(ws.endsWith(path.sep) ? ws : ws + path.sep) }) ?? newest[0]
}

/** lanHost only for a request that came in on the LAN socket, already through lanGate. */
export function allowed(h: http.IncomingHttpHeaders, port: number, lanHost?: string): boolean {
  if (h['x-switchboard'] !== '1') return false
  const hosts = lanHost ? [`${lanHost}:${port}`] : [`127.0.0.1:${port}`, `localhost:${port}`]
  if (!hosts.includes(String(h.host))) return false
  return h.origin === undefined || hosts.some(x => h.origin === `http://${x}`)
}

export type Lan = { host: string; secret: string }
// Tailscale hands out 100.64.0.0/10.
const tailnet = (ip: string) => { const [a, b] = ip.split('.').map(Number); return a === 100 && b >= 64 && b <= 127 }
/** This Mac's first Wi-Fi (or other LAN) IPv4 and its Tailscale one, from os.networkInterfaces addresses. */
export const lanHosts = (ips: string[]) => ({ wifi: ips.find(ip => !tailnet(ip)), tailscale: ips.find(tailnet) })
// Browsers send cookies to every port on the host, so the port in the name only keeps two Switchboard apps apart.
// Anything else on this Mac that sees it could already read web.lan.
export const lanCookie = (port: number) => `sb${port}`

/** The phone link's secret, kept in a file so a restart (an update) does not log the phone out. */
export function phoneSecret(file: string): string {
  const kept = (() => { try { return fs.readFileSync(file, 'utf8').trim() } catch { return '' } })()
  if (/^[0-9a-f]{64}$/.test(kept)) return kept
  const secret = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, secret, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  return secret
}

const same = (a: string | null | undefined, b: string) => {
  const x = Buffer.from(a ?? ''), y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/** Phone access. lan is undefined on the loopback socket, which passes as before. On the LAN socket: the
 * Mac's own Host only, then /?k=<secret> once ('login': set the cookie), then the cookie on every request. */
export function lanGate(h: http.IncomingHttpHeaders, url: string, port: number, lan: Lan | undefined): 'ok' | 'login' | 'deny' {
  if (!lan) return 'ok'
  if (h.host !== `${lan.host}:${port}`) return 'deny'
  // '//' and the like throw, and a throw here takes the whole app down.
  let u: URL
  try { u = new URL(url, 'http://x') } catch { return 'deny' }
  if (u.pathname === '/' && u.searchParams.has('k')) return same(u.searchParams.get('k'), lan.secret) ? 'login' : 'deny'
  const name = `${lanCookie(port)}=`
  const cookie = String(h.cookie ?? '').split(';').map(c => c.trim()).find(c => c.startsWith(name))
  return same(cookie?.slice(name.length), lan.secret) ? 'ok' : 'deny'
}

// Window files only: company.json and workspaces.json lack a port and token, so pickWindow drops them.
async function windows(): Promise<Partial<Win>[]> {
  const out: Partial<Win>[] = []
  for (const n of await fs.promises.readdir(DIR).catch(() => [] as string[])) {
    if (!n.endsWith('.json') || n === 'workspaces.json') continue
    const p = path.join(DIR, n)
    try { out.push({ ...JSON.parse(await fs.promises.readFile(p, 'utf8')), mtimeMs: (await fs.promises.stat(p)).mtimeMs }) } catch { /* mid-write */ }
  }
  return out
}

export async function proxyHub(req: http.IncomingMessage, res: http.ServerResponse, port: number, workspace: string, lanHost?: string): Promise<void> {
  let u: URL
  try { u = new URL(req.url ?? '/', 'http://x') } catch { res.writeHead(400).end(); return }
  const route = req.method === 'GET' && u.pathname === '/hub/state' ? 'state' : req.method === 'POST' && u.pathname === '/hub/command' ? 'command' : undefined
  if (!route || !allowed(req.headers, port, lanHost)) { res.writeHead(route ? 403 : 404).end(); return }
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > MAX_BODY) { res.writeHead(413).end(); return }
  }
  const win = pickWindow(await windows(), workspace)
  if (!win) { res.writeHead(502).end(); return }
  const up = http.request({ host: '127.0.0.1', port: win.port, method: req.method, path: `/hub/${route}?token=${encodeURIComponent(win.hubToken)}`, headers: { 'Content-Type': 'application/json' }, timeout: 5000 }, r => {
    res.writeHead(r.statusCode ?? 502, { 'Content-Type': r.headers['content-type'] ?? 'text/plain', 'Cache-Control': 'no-store' })
    r.pipe(res)
  })
  up.on('error', () => { if (!res.headersSent) res.writeHead(502).end() })
  up.on('timeout', () => up.destroy())
  up.end(body)
}
