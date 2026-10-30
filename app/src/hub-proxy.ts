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
import * as zlib from 'zlib'

type Win = { port: number; hubToken: string; workspace: string; mtimeMs: number; pid?: number }
const DIR = path.join(os.homedir(), '.claude', 'switchboard')
const MAX_BODY = 64 * 1024

// EPERM: the process exists but belongs to someone else.
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

const real = (p: string) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }

const usable = (f: Partial<Win>, alive: (pid: number) => boolean): f is Win =>
  typeof f.port === 'number' && typeof f.hubToken === 'string' && typeof f.workspace === 'string' && (typeof f.pid !== 'number' || alive(f.pid))

/** The live window holding the command's folder (deepest, then newest), else the one holding the app's folder, else the newest.
 * A closed window can leave its file behind. */
export function pickWindow(files: Partial<Win>[], workspace: string, alive: (pid: number) => boolean = pidAlive, folder?: string): Win | undefined {
  const ok = files.filter(f => usable(f, alive))
  const newest = [...ok].sort((a, b) => b.mtimeMs - a.mtimeMs)
  const holding = (dir: string) => {
    const here = real(dir)
    const ws = (f: Win) => real(f.workspace)
    return newest.filter(f => here === ws(f) || here.startsWith(ws(f).endsWith(path.sep) ? ws(f) : ws(f) + path.sep))
      .sort((a, b) => ws(b).length - ws(a).length)[0]
  }
  return (folder ? holding(folder) : undefined) ?? holding(workspace) ?? newest[0]
}

/** The project a to-do or new-chat command names, so its chat opens in that project's window. Others stay on the usual
 * window: their answers (a tool pick, a dev terminal) live in the window that ran them, and the page reads that one. */
export function commandFolder(body: string): string | undefined {
  try {
    const c = JSON.parse(body) as { type?: unknown; path?: unknown }
    const routed = typeof c?.type === 'string' && (c.type.startsWith('hub-todo-') || c.type === 'hub-new-chat')
    return routed && typeof c.path === 'string' ? c.path : undefined
  } catch { return undefined }
}

/** lan only for a request whose localAddress is a LAN one, already through lanGate. */
export function allowed(h: http.IncomingHttpHeaders, port: number, lan?: Lan): boolean {
  if (h['x-switchboard'] !== '1') return false
  const hosts = lan ? lanHostsFor(lan, port) : [`127.0.0.1:${port}`, `localhost:${port}`]
  if (!hosts.includes(String(h.host).toLowerCase())) return false
  return h.origin === undefined || sameOrigin(h.origin, hosts)
}

/** names: this Mac's mDNS and MagicDNS names, taken on any LAN socket like its address. */
export type Lan = { host: string; secret: string; names?: string[] }
import { phoneCode } from '../../extension/src/hub/lan'
export { lanHosts, localName, macNames, phoneCode, tailscaleName } from '../../extension/src/hub/lan'

// Exact names only: a rebound name (evil.test pointing here) never matches.
const lanHostsFor = (lan: Lan, port: number) => [lan.host, ...(lan.names ?? [])].map(x => `${x.toLowerCase()}:${port}`)
const onLanHost = (h: http.IncomingHttpHeaders, port: number, lan: Lan) => lanHostsFor(lan, port).includes(String(h.host).toLowerCase())
const sameOrigin = (origin: string, hosts: string[]) => hosts.some(x => origin.toLowerCase() === `http://${x}`)

/** The --lan server listens on 0.0.0.0, so the address a request came in on decides: loopback passes as before,
 * anything else is gated and pinned to that address. Read per request, so a new Wi-Fi address needs no restart. */
export function lanFor(localAddress: string | undefined, secret: string, names: string[] = []): Lan | undefined {
  const host = (localAddress ?? '').replace(/^::ffff:/, '')
  return host.startsWith('127.') || host === '::1' ? undefined : { host, secret, names }
}
// Browsers send cookies to every port on the host, so the port in the name only keeps two Switchboard apps apart.
// Anything else on this Mac that sees it could already read phone.secret.
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

/** Phone access. lan is undefined for a loopback localAddress, which passes as before. For a LAN one: the
 * Mac's own Host only, then /?k=<secret> once ('login': set the cookie), then the cookie on every request. */
export function lanGate(h: http.IncomingHttpHeaders, url: string, port: number, lan: Lan | undefined): 'ok' | 'login' | 'deny' {
  if (!lan) return 'ok'
  if (!onLanHost(h, port, lan)) return 'deny'
  // '//' and the like throw, and a throw here takes the whole app down.
  let u: URL
  try { u = new URL(url, 'http://x') } catch { return 'deny' }
  if (u.pathname === '/' && u.searchParams.has('k')) return same(u.searchParams.get('k'), lan.secret) ? 'login' : 'deny'
  const name = `${lanCookie(port)}=`
  const cookie = String(h.cookie ?? '').split(';').map(c => c.trim()).find(c => c.startsWith(name))
  return same(cookie?.slice(name.length), lan.secret) ? 'ok' : 'deny'
}

/** What a LAN request lanGate denied gets instead of a bare 403: the sign-in page for a page on the Mac's own Host,
 * the code check for POST /login there, an ask to the Mac on POST /device and its answer on GET /device/wait.
 * Assets, /events and /hub/* stay refused. */
export function deniedAs(method: string | undefined, h: http.IncomingHttpHeaders, url: string, port: number, lan: Lan): 'page' | 'login' | 'device' | 'wait' | 'forbid' {
  if (!onLanHost(h, port, lan)) return 'forbid'
  let u: URL
  try { u = new URL(url, 'http://x') } catch { return 'forbid' }
  if (method === 'POST') {
    // Another site's form could post wrong codes and keep sign-in locked, or fill the Mac with asks.
    if (h.origin !== undefined && !sameOrigin(h.origin, lanHostsFor(lan, port))) return 'forbid'
    return u.pathname === '/login' ? 'login' : u.pathname === '/device' ? 'device' : 'forbid'
  }
  if (method === 'GET' && u.pathname === '/device/wait') return 'wait'
  return method === 'GET' && (u.pathname === '/' || String(h.accept ?? '').includes('text/html')) ? 'page' : 'forbid'
}

export type DeviceAsk = { id: string; ip: string; ua: string; host: string; network: 'Wi-Fi' | 'Tailscale'; at: number }
const ASK_MS = 2 * 60_000

/** Devices asking the Mac to let them in. At most 3 wait at once; an unanswered one is gone after 2 minutes.
 * state() hands an answer out once, to the device that knows the id. */
export function deviceAsks(now = Date.now) {
  const asks = new Map<string, DeviceAsk & { allow?: boolean }>()
  const prune = () => { for (const [id, a] of asks) if (now() - a.at >= ASK_MS) asks.delete(id) }
  return {
    ask(d: Omit<DeviceAsk, 'id' | 'at'>): DeviceAsk | undefined {
      prune()
      if ([...asks.values()].filter(a => a.allow === undefined).length >= 3) return undefined
      const a = { ...d, id: crypto.randomBytes(16).toString('hex'), at: now() }
      asks.set(a.id, a)
      return a
    },
    answer(id: string, allow: boolean): boolean {
      prune()
      const a = asks.get(id)
      if (!a || a.allow !== undefined) return false
      a.allow = allow
      return true
    },
    state(id: string): 'pending' | 'allowed' | 'denied' | 'gone' {
      prune()
      const a = asks.get(id)
      if (!a) return 'gone'
      if (a.allow === undefined) return 'pending'
      asks.delete(id)
      return a.allow ? 'allowed' : 'denied'
    },
  }
}

/** "iPhone Safari" and the like, for the Mac's prompt. */
export function uaSummary(ua: string | undefined): string {
  const s = ua ?? ''
  const device = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Macintosh/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : ''
  const browser = /Edg(e|A|iOS)?\//.test(s) ? 'Edge' : /Firefox\/|FxiOS/.test(s) ? 'Firefox' : /Chrome\/|CriOS/.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : ''
  return device && browser ? `${device} ${browser}` : device || browser || 'Unknown browser'
}

/** True when token is the hubToken of a live VS Code window, read from the window files. */
export function liveToken(files: Partial<Win>[], token: unknown, alive: (pid: number) => boolean = pidAlive): boolean {
  return typeof token === 'string' && token !== '' && files.some(f => usable(f, alive) && same(token, f.hubToken))
}

const LOCK_MS = 10 * 60_000

/** The typed code check, one per server. 5 wrong codes in 10 minutes lock it, the right code too; a right code clears the count. */
// ponytail: one lock for everyone, so anyone on the network can lock sign-in (the QR link still works); per-IP counts if that bites.
export function codeLogin(now = Date.now) {
  let wrong: number[] = []
  return (code: string, secret: string): 'ok' | 'wrong' | 'locked' => {
    wrong = wrong.filter(t => now() - t < LOCK_MS)
    if (wrong.length >= 5) return 'locked'
    if (same(code, phoneCode(secret))) { wrong = []; return 'ok' }
    wrong.push(now())
    return 'wrong'
  }
}

const pageHead = (title: string, extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${extra}
<title>${title}</title><style>
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--ink:#1d1d1b;--mute:#6b6b66;--line:#d9d9d4;--blue:#2f6fde;--red:#c4372b}
@media (prefers-color-scheme: dark){:root{--bg:#141413;--card:#1f1f1d;--ink:#ecece8;--mute:#a3a39c;--line:#3a3a36;--blue:#6d9cf0;--red:#f07a6d}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--ink);font:400 15px/1.5 -apple-system,system-ui,sans-serif}
main{width:100%;max-width:320px;display:grid;gap:12px;padding:20px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
form{display:grid;gap:12px}form+form{padding-top:12px;border-top:1px solid var(--line)}
h1{margin:0;font-size:18px}p{margin:0;color:var(--mute)}.note{color:var(--red)}a{color:var(--blue)}
input{font:500 24px/1 ui-monospace,Menlo,monospace;letter-spacing:.2em;text-align:center;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);width:100%}
button{font:600 15px/1 inherit;padding:12px;border:0;border-radius:8px;background:var(--blue);color:#fff}
button.alt{background:transparent;color:var(--blue);border:1px solid var(--line)}
</style></head><body><main>`

/** The sign-in page for a typed address. Self-contained: the device has no cookie, so nothing else would load. */
export function signInPage(note?: string): string {
  return `${pageHead('Switchboard sign-in')}<h1>Switchboard</h1>${note ? `<p class="note" role="alert">${note}</p>` : ''}
<form action="/login" method="post"><p>Enter the code shown in Switchboard's Phone menu on your Mac.</p>
<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" aria-label="Code" required>
<button type="submit">Sign in with the code</button></form>
<form action="/device" method="post"><p>Or, when someone is at the Mac, ask it: VS Code shows a prompt there to click Allow.</p>
<button type="submit" class="alt">Ask the Mac to let me in</button></form></main></body></html>`
}

/** Shown while the Mac decides; reloads itself every 2 s, no script needed. */
export function waitPage(id: string): string {
  const safe = id.replace(/[^0-9a-f]/g, '')
  return `${pageHead('Waiting for the Mac', `<meta http-equiv="refresh" content="2;url=/device/wait?id=${safe}">`)}<h1>Waiting for your Mac</h1>
<p role="status">Click Allow in the prompt VS Code shows on your Mac. This page goes on by itself.</p>
<p><a href="/">Cancel and use the code instead</a></p></main></body></html>`
}

// Window files only: company.json and workspaces.json lack a port and token, so pickWindow drops them.
export async function windows(): Promise<Partial<Win>[]> {
  const out: Partial<Win>[] = []
  for (const n of await fs.promises.readdir(DIR).catch(() => [] as string[])) {
    if (!n.endsWith('.json') || n === 'workspaces.json') continue
    const p = path.join(DIR, n)
    try { out.push({ ...JSON.parse(await fs.promises.readFile(p, 'utf8')), mtimeMs: (await fs.promises.stat(p)).mtimeMs }) } catch { /* mid-write */ }
  }
  return out
}

/** Posts body to /hub/device on every live window; fire and forget. */
export async function tellWindows(body: object): Promise<void> {
  for (const w of (await windows()).filter(f => usable(f, pidAlive))) {
    const r = http.request({ host: '127.0.0.1', port: w.port, method: 'POST', path: `/hub/device?token=${encodeURIComponent(w.hubToken)}`, headers: { 'Content-Type': 'application/json' }, timeout: 2000 }, x => x.resume())
    r.on('error', () => {})
    r.on('timeout', () => r.destroy())
    r.end(JSON.stringify(body))
  }
}

/** list: the window files, swapped in tests so none reaches a real window. */
export async function proxyHub(req: http.IncomingMessage, res: http.ServerResponse, port: number, workspace: string, lan?: Lan, list = windows): Promise<void> {
  let u: URL
  try { u = new URL(req.url ?? '/', 'http://x') } catch { res.writeHead(400).end(); return }
  const route = req.method === 'GET' && u.pathname === '/hub/state' ? 'state' : req.method === 'POST' && u.pathname === '/hub/command' ? 'command' : undefined
  if (!route || !allowed(req.headers, port, lan)) { res.writeHead(route ? 403 : 404).end(); return }
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > MAX_BODY) { res.writeHead(413).end(); return }
  }
  const win = pickWindow(await list(), workspace, undefined, route === 'command' ? commandFolder(body) : undefined)
  if (!win) { res.writeHead(502).end(); return }
  const up = http.request({ host: '127.0.0.1', port: win.port, method: req.method, path: `/hub/${route}?token=${encodeURIComponent(win.hubToken)}`, headers: { 'Content-Type': 'application/json' }, timeout: 5000 }, r => {
    const head = { 'Content-Type': r.headers['content-type'] ?? 'text/plain', 'Cache-Control': 'no-store' }
    if (route !== 'state' || r.statusCode !== 200) { res.writeHead(r.statusCode ?? 502, head); r.pipe(res); return }
    // The page polls state every 2s: a 304 when nothing changed, else gzip, since a full state runs to a few hundred KB.
    const parts: Buffer[] = []
    r.on('data', (c: Buffer) => parts.push(c))
    r.on('error', () => { if (!res.headersSent) res.writeHead(502).end() })
    r.on('end', () => {
      const raw = Buffer.concat(parts)
      const etag = `"${crypto.createHash('sha1').update(raw).digest('hex')}"`
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-store' }).end(); return }
      const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
      res.writeHead(200, { ...head, ETag: etag, Vary: 'Accept-Encoding', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) })
      res.end(gzip ? zlib.gzipSync(raw) : raw)
    })
  })
  up.on('error', () => { if (!res.headersSent) res.writeHead(502).end() })
  up.on('timeout', () => up.destroy())
  up.end(body)
}
