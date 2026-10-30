/**
 * Keeps one Apple Notes note, "Switchboard access", with the phone code and sign-in links.
 * Rewritten only when its body changes; the state file holds a hash, never the secret.
 */

import { createHash } from 'crypto'
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { PhoneUrls } from './types'
import { createLogger } from '../logger'

const log = createLogger('Hub')
const TITLE = 'Switchboard access'
const STATE_FILE = path.join(os.homedir(), '.claude', 'switchboard', 'access-note.sha')
const RETRY_MS = 10 * 60_000
// Every window refreshes; a lock file keeps two of them from each creating the note.
const LOCK_MS = 60_000
const LINKS: [keyof PhoneUrls, string][] = [['tailscaleName', 'Tailscale'], ['tailscale', 'Tailscale IP'], ['wifiName', 'Wi-Fi (home only)'], ['wifi', 'Wi-Fi IP (home only)']]

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function noteBody(urls: PhoneUrls): string {
  const links = LINKS.flatMap(([k, label]) => urls[k] ? [`<div>${label}: <a href="${esc(urls[k]!)}">${esc(urls[k]!)}</a></div>`] : [])
  return [`<div><h1>${TITLE}</h1></div>`, `<div>Code: <b>${esc(urls.code ?? '')}</b></div>`, ...links,
    '<div>Tailscale must be on for these to work away from home. This note is private; do not share it.</div>'].join('\n')
}

// The body comes in through SB_NOTE so it never shows in ps. Skips a match in Recently Deleted.
const SCRIPT = `set b to system attribute "SB_NOTE"
tell application "Notes"
  set acct to default account
  repeat with n in (notes of acct whose name is "${TITLE}")
    if name of container of n is not "Recently Deleted" then
      set body of n to b
      return
    end if
  end repeat
  make new note at default folder of acct with properties {body:b}
end tell`

export type Run = (args: string[], env: Record<string, string>) => Promise<void>
const osascript: Run = (args, env) => new Promise((resolve, reject) =>
  execFile('osascript', args, { timeout: 30_000, env: { ...process.env, ...env } }, err => err ? reject(err) : resolve()))

const state = new Map<string, { busy?: boolean; failedAt?: number; logged?: boolean }>()

/** True when it wrote the note. On a Mac only; one call in flight, and after a failure none for ten minutes. */
export async function syncAccessNote(urls: PhoneUrls | null, platform = process.platform, run = osascript, stateFile = STATE_FILE, now = Date.now): Promise<boolean> {
  if (platform !== 'darwin' || !urls?.code || !LINKS.some(([k]) => urls[k])) return false
  const s = state.get(stateFile) ?? {}
  state.set(stateFile, s)
  if (s.busy || (s.failedAt !== undefined && now() - s.failedAt < RETRY_MS)) return false
  s.busy = true
  const lock = stateFile + '.lock'
  try { if (Date.now() - fs.statSync(lock).mtimeMs < LOCK_MS) { s.busy = false; return false } } catch { /* no lock */ }
  try { fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, '') } catch { /* best effort */ }
  try {
    const body = noteBody(urls)
    const sha = createHash('sha256').update(body).digest('hex')
    if ((await fs.promises.readFile(stateFile, 'utf8').catch(() => '')).trim() === sha) return false
    try {
      await run(['-e', SCRIPT], { SB_NOTE: body })
    } catch (err) {
      s.failedAt = now()
      if (!s.logged) log.warn(`Access note: could not update Apple Notes (${(err as Error).message.split('\n')[0]})`)
      s.logged = true
      return false
    }
    s.failedAt = undefined
    s.logged = false
    await fs.promises.mkdir(path.dirname(stateFile), { recursive: true })
    await fs.promises.writeFile(stateFile, sha + '\n', { mode: 0o600 })
    return true
  } finally {
    s.busy = false
    fs.rmSync(lock, { force: true })
  }
}

/** Drops the stored hash, so the next sync writes the note even if it was deleted by hand. */
export const forgetAccessNote = (stateFile = STATE_FILE) => fs.rmSync(stateFile, { force: true })
