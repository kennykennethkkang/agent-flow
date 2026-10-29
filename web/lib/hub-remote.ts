/**
 * The standalone web app's way to the live hub: its own server's /hub proxy
 * (app/src/hub-proxy.ts), which adds the window's token. Used by use-hub.ts.
 */
import type { HubState } from './hub-types'
import type { HubCommand } from './vscode-bridge'

const HEADERS = { 'X-Switchboard': '1', 'Content-Type': 'application/json' }

export async function fetchHub(f: typeof fetch = fetch): Promise<HubState | null> {
  try {
    const r = await f('/hub/state', { headers: HEADERS, cache: 'no-store' })
    return r.ok ? ((await r.json()) as HubState) : null
  } catch {
    return null
  }
}

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
