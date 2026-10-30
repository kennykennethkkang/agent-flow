/**
 * The standalone web app's way to the live hub: its own server's /hub proxy
 * (app/src/hub-proxy.ts), which adds the window's token. Used by use-hub.ts.
 */
import type { HubState } from './hub-types'
import type { HubCommand } from './vscode-bridge'

const HEADERS = { 'X-Switchboard': '1', 'Content-Type': 'application/json' }

/** What the page says while it cannot reach the hub; status undefined: no answer at all. */
export const downReason = (status: number | undefined) =>
  status === 401 || status === 403 ? 'This device is signed out. Scan the QR code or type the code from the Switchboard panel again.'
  : status === undefined ? 'Cannot reach the Mac. Check Wi-Fi or Tailscale.'
  : 'No VS Code window with Switchboard is open on the Mac.'

// The proxy answers 304 when the state has not changed since this ETag; no-store keeps the browser cache out of it.
let last: { etag: string; hub: HubState } | undefined

export async function fetchHubWhy(f: typeof fetch = fetch): Promise<{ hub: HubState | null; why?: string }> {
  try {
    const r = await f('/hub/state', { headers: { ...HEADERS, ...(last ? { 'If-None-Match': last.etag } : {}) }, cache: 'no-store' })
    if (r.status === 304 && last) return { hub: last.hub }
    if (!r.ok) return { hub: null, why: downReason(r.status) }
    const hub = (await r.json()) as HubState
    const etag = r.headers.get('ETag')
    last = etag ? { etag, hub } : undefined
    return { hub }
  } catch {
    return { hub: null, why: downReason(undefined) }
  }
}

export const fetchHub = async (f: typeof fetch = fetch) => (await fetchHubWhy(f)).hub

/** Undefined when the command ran; otherwise why not, from the hub's own reply where it gave one. */
export async function postCommand(c: HubCommand, f: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const r = await f('/hub/command', { method: 'POST', headers: HEADERS, body: JSON.stringify(c) })
    if (r.ok) return undefined
    return (await r.text().catch(() => '')).trim().slice(0, 200) || `the hub answered ${r.status}`
  } catch {
    return 'could not reach the hub'
  }
}
