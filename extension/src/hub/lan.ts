/** This Mac's LAN addresses and names, shared by the standalone app (server) and the panel (phone links). */
import { execFile } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'

// Tailscale hands out 100.64.0.0/10.
const tailnet = (ip: string) => { const [a, b] = ip.split('.').map(Number); return a === 100 && b >= 64 && b <= 127 }
/** This Mac's first Wi-Fi (or other LAN) IPv4 and its Tailscale one, from os.networkInterfaces addresses. */
export const lanHosts = (ips: string[]) => ({ wifi: ips.find(ip => !tailnet(ip)), tailscale: ips.find(tailnet) })
export const ipv4s = () => Object.values(os.networkInterfaces()).flat().flatMap(i => (i && i.family === 'IPv4' && !i.internal ? [i.address] : []))
/** The 6 digits typed on a new device instead of the QR. From the secret, so it stays the same across restarts. */
export const phoneCode = (secret: string) => String(crypto.createHmac('sha256', secret).update('switchboard-code').digest().readUInt32BE(0) % 1e6).padStart(6, '0')

// VS Code's PATH often lacks /usr/local/bin; the Mac App Store app keeps its CLI inside the bundle.
const TS_BINS = ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
export const tailscaleBin = () => TS_BINS.find(b => fs.existsSync(b))

// Only plain DNS labels, since a name ends up in Host checks and links.
const okName = (n: string) => (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(n) ? n : undefined)
/** `scutil --get LocalHostName` output as its .local name. */
export const localName = (out: string) => (out.trim() ? okName(`${out.trim().toLowerCase()}.local`) : undefined)
/** Self.DNSName from `tailscale status --json`, while tailscale is up. */
export function tailscaleName(json: string): string | undefined {
  try {
    const s = JSON.parse(json)
    return s.BackendState === 'Running' && typeof s.Self?.DNSName === 'string' ? okName(s.Self.DNSName.replace(/\.$/, '').toLowerCase()) : undefined
  } catch { return undefined }
}

export type MacNames = { wifi?: string; tailscale?: string }
const out = (bin: string, args: string[]) => new Promise<string>(done => execFile(bin, args, { timeout: 5000 }, (err, stdout) => done(err ? '' : String(stdout))))
async function readNames(): Promise<MacNames> {
  const ts = tailscaleBin()
  const [local, tail] = await Promise.all([
    process.platform === 'darwin' ? out('scutil', ['--get', 'LocalHostName']) : Promise.resolve(''),
    ts ? out(ts, ['status', '--self', '--json']) : Promise.resolve(''),
  ])
  return { wifi: localName(local), tailscale: tailscaleName(tail) }
}
let names: MacNames = {}
let namesAt = -Infinity
/** This Mac's mDNS and MagicDNS names as last read. A read older than 3 minutes starts a new one in the background, so no caller waits on scutil or tailscale. */
export function macNames(now = Date.now()): MacNames {
  if (now - namesAt >= 3 * 60_000) { namesAt = now; void readNames().then(n => { names = n }) }
  return names
}
