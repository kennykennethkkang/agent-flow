/**
 * AWS sign-ins: profiles from ~/.aws/config, their status, display labels and which Chrome
 * profile opens their sign-in. The parsers and rewrites are pure (tested); ~/.aws/credentials is never read or written.
 */
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { writeJsonAtomic } from '../hook-entries'
import type { AwsProfile, AwsStatus, ChromeProfile } from './types'

const HOME = os.homedir()
export const AWS_CONFIG = path.join(HOME, '.aws', 'config')
const SB = path.join(HOME, '.claude', 'switchboard')
const LABELS = path.join(SB, 'aws-labels.json')
const PREFS = path.join(SB, 'aws-prefs.json')
export const OPEN_CHROME = path.join(SB, 'aws-open-chrome.sh')
const CHROME_STATE = path.join(HOME, 'Library', 'Application Support', 'Google', 'Chrome', 'Local State')

export const validProfileName = (s: string) => /^[A-Za-z0-9._@+-]{1,64}$/.test(s)
export const validRegion = (s: string) => /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/.test(s)

export type Section = { name: string; isDefault: boolean; values: Record<string, string> }
type Block = { header: string; start: number; end: number }

const HEADER = /^\s*\[([^\]]+)\]\s*$/
const nameOf = (header: string) => (header === 'default' ? 'default' : /^profile\s+(.+)$/.exec(header)?.[1].trim())

function blocks(lines: string[]): Block[] {
  const out: Block[] = []
  lines.forEach((l, i) => {
    const m = HEADER.exec(l)
    if (!m) return
    if (out.length) out[out.length - 1].end = i
    out.push({ header: m[1].trim(), start: i, end: lines.length })
  })
  return out
}

/** The key = value lines of a block. Trailing blanks and comments are dropped: a comment right above a header belongs to that next section. */
const body = (lines: string[], b: Block) => {
  const rows = lines.slice(b.start + 1, b.end)
  while (rows.length && /^\s*([#;].*)?$/.test(rows[rows.length - 1])) rows.pop()
  return rows
}

const valuesOf = (rows: string[]) => Object.fromEntries(rows.flatMap(r => {
  const m = /^\s*([\w.-]+)\s*=\s*(.*?)\s*$/.exec(r)
  return m ? [[m[1], m[2]]] : []
}))

/** Profiles in file order; sso-session and services blocks are not profiles. */
export function parseAwsConfig(text: string): Section[] {
  const lines = text.split(/\r?\n/)
  return blocks(lines).flatMap(b => {
    const name = nameOf(b.header)
    return name ? [{ name, isDefault: name === 'default', values: valuesOf(body(lines, b)) }] : []
  })
}

/** The 12-digit account a profile signs in to, from its config alone. */
export function accountOf(v: Record<string, string>): string | undefined {
  const arn = /^arn:aws[\w-]*:(?:iam|sts)::(\d{12}):/
  return arn.exec(v.login_session ?? '')?.[1] ?? (/^\d{12}$/.test(v.sso_account_id ?? '') ? v.sso_account_id : undefined) ?? arn.exec(v.role_arn ?? '')?.[1]
}

const stamp = (now: number) => new Date(now).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')

const CRED_KEYS = new Set(['aws_access_key_id', 'credential_process', 'sso_session', 'sso_start_url', 'login_session', 'web_identity_token_file'])

/**
 * The config with [default] holding `name`'s settings. The old default is kept as
 * [profile previous-default-<time>] whenever it had settings that differ from the new ones. undefined: no such profile.
 */
export function makeDefault(text: string, name: string, now = Date.now()): string | undefined {
  if (name === 'default') return undefined
  const lines = text.split(/\r?\n/)
  const all = blocks(lines)
  const target = all.find(b => nameOf(b.header) === name && name !== 'default')
  if (!target) return undefined
  const fresh = body(lines, target)
  const old = all.find(b => b.header === 'default')
  const oldRows = old ? body(lines, old) : []
  const same = JSON.stringify(Object.entries(valuesOf(oldRows)).sort()) === JSON.stringify(Object.entries(valuesOf(fresh)).sort())
  const kept = `previous-default-${stamp(now)}`
  const backup = oldRows.some(r => r.trim()) && !same ? ['', `[profile ${kept}]`, ...oldRows] : []
  // When the old [default] held its credentials in config, every profile sourcing from it follows them to the backup.
  // Keys in the credentials file stay under [default], so source_profile = default stays as is.
  const moved = Object.keys(valuesOf(oldRows)).some(k => CRED_KEYS.has(k)) && backup.length > 0
  const def = ['[default]', ...fresh, '']
  const joined = old ? [...lines.slice(0, old.start), ...def, ...lines.slice(old.end)] : [...def, ...lines]
  const out = moved ? joined.map(r => (/^\s*source_profile\s*=\s*default\s*$/.test(r) ? `source_profile = ${kept}` : r)) : joined
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return [...out, ...backup, ''].join('\n')
}

/** The config with a new [profile name] in region; undefined when the name or region is bad or taken. */
export function addProfile(text: string, name: string, region: string): string | undefined {
  if (!validProfileName(name) || name === 'default' || !validRegion(region)) return undefined
  if (parseAwsConfig(text).some(s => s.name === name)) return undefined
  return `${text.replace(/\s*$/, '')}${text.trim() ? '\n\n' : ''}[profile ${name}]\nregion = ${region}\n`
}

/**
 * The config without [profile name] and the comment right above it, or why not: [default] stays, as does the
 * profile [default] copies (Make default) and any profile another one names as source_profile.
 */
export function removeProfile(text: string, name: string): { text: string } | { problem: string } {
  if (name === 'default') return { problem: 'the default profile cannot be deleted' }
  const lines = text.split(/\r?\n/)
  const all = blocks(lines)
  const target = all.find(b => nameOf(b.header) === name)
  if (!target) return { problem: `no AWS profile named ${name}` }
  const def = all.find(b => b.header === 'default')
  const vals = (b: Block) => JSON.stringify(Object.entries(valuesOf(body(lines, b))).sort())
  if (def && body(lines, def).some(r => r.trim()) && vals(def) === vals(target)) return { problem: `${name} is the current default; make another profile the default first` }
  const user = parseAwsConfig(text).find(s => s.values.source_profile === name)
  if (user) return { problem: `${user.name} signs in through ${name} (source_profile)` }
  let start = target.start
  while (start > 0 && /^\s*[#;]/.test(lines[start - 1])) start--
  let end = target.start + 1 + body(lines, target).length
  while (end < target.end && !lines[end].trim()) end++
  const out = [...lines.slice(0, start), ...lines.slice(end)]
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return { text: [...out, ''].join('\n') }
}

const SIGNS_IN = ['login_session', 'sso_session', 'sso_start_url', 'role_arn', 'credential_process', 'web_identity_token_file']

/** Signed in when STS answered; expired when it did not but the profile has a way to sign in; else never. */
export function awsStatus(ok: boolean, stderr: string, values: Record<string, string>): AwsStatus {
  if (ok) return 'signed-in'
  if (/Unable to locate credentials|could not be found|NoCredentialProviders/i.test(stderr)) return 'never'
  return SIGNS_IN.some(k => values[k]) ? 'expired' : 'never'
}

/** Chrome's profiles (folder, name, signed-in email) from its Local State file. */
export function chromeProfiles(localState: string): ChromeProfile[] {
  try {
    const cache = JSON.parse(localState)?.profile?.info_cache ?? {}
    return Object.entries(cache as Record<string, { name?: unknown; user_name?: unknown }>).flatMap(([dir, p]) =>
      p && typeof p === 'object' && typeof p.name === 'string'
        ? [{ dir, name: p.name, ...(typeof p.user_name === 'string' && p.user_name ? { email: p.user_name } : {}) }] : [])
  } catch { return [] }
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
/** The profile picked for the deepest project folder holding `cwd`. */
export function profileFor(projects: Record<string, string>, cwd: string): string | undefined {
  const c = norm(cwd)
  const hit = Object.keys(projects).filter(k => c === norm(k) || c.startsWith(`${norm(k)}/`)).sort((a, b) => b.length - a.length)[0]
  return hit ? projects[hit] : undefined
}

// ─── Files ───────────────────────────────────────────────────────────────────

const readJson = (file: string): Record<string, unknown> => {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { return {} }
}
const strings = (v: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).filter(([, x]) => typeof x === 'string')) as Record<string, string>

export type AwsPrefs = { chrome: Record<string, string>; projects: Record<string, string> }
export const readLabels = () => strings(readJson(LABELS))
export const writeLabels = (labels: Record<string, string>) => { fs.mkdirSync(SB, { recursive: true }); writeJsonAtomic(LABELS, labels) }
export const readPrefs = (): AwsPrefs => { const j = readJson(PREFS); return { chrome: strings(j.chrome), projects: strings(j.projects) } }
export const writePrefs = (p: AwsPrefs) => { fs.mkdirSync(SB, { recursive: true }); writeJsonAtomic(PREFS, p) }
export const readChrome = (): ChromeProfile[] => { try { return chromeProfiles(fs.readFileSync(CHROME_STATE, 'utf8')) } catch { return [] } }
export const readAwsConfig = () => { try { return fs.readFileSync(AWS_CONFIG, 'utf8') } catch { return '' } }

/** Writes the config through a temp file and a rename, keeping its mode (0600 for a new one). */
export function writeAwsConfig(text: string, file = AWS_CONFIG): void {
  let mode = 0o600
  try { mode = fs.statSync(file).mode & 0o777 } catch { fs.mkdirSync(path.dirname(file), { recursive: true }) }
  const tmp = `${file}.switchboard-${process.pid}.tmp`
  fs.writeFileSync(tmp, text, { mode })
  fs.renameSync(tmp, file)
}

/** Deletes [profile name] after copying the config to config.backup-<time> beside it. Answers why it could not. */
export function deleteAwsProfile(name: string, file = AWS_CONFIG, now = Date.now()): string | undefined {
  if (!validProfileName(name)) return 'Not a profile name'
  const text = fs.readFileSync(file, 'utf8')
  const r = removeProfile(text, name)
  if ('problem' in r) return r.problem
  fs.writeFileSync(`${file}.backup-${stamp(now)}`, text, { mode: 0o600, flag: 'wx' })
  writeAwsConfig(r.text, file)
  return undefined
}

/** The script Python's webbrowser runs (BROWSER) so `aws login` opens in one Chrome profile; the folder comes from the env, never the script. */
export function writeOpenChrome(): string {
  fs.mkdirSync(SB, { recursive: true })
  fs.writeFileSync(OPEN_CHROME, '#!/bin/sh\nexec /usr/bin/open -na "Google Chrome" --args --profile-directory="$SWITCHBOARD_CHROME_DIR" "$1"\n', { mode: 0o700 })
  fs.chmodSync(OPEN_CHROME, 0o700)
  return OPEN_CHROME
}

/** VS Code's PATH often lacks Homebrew's bin. */
export const awsBinary = () => ['/opt/homebrew/bin/aws', '/usr/local/bin/aws'].find(p => fs.existsSync(p)) ?? 'aws'

function check(name: string): Promise<{ ok: boolean; account?: string; stderr: string }> {
  return new Promise(resolve => execFile(awsBinary(), ['sts', 'get-caller-identity', '--profile', name, '--output', 'json'],
    { timeout: 8000, maxBuffer: 1 << 20, windowsHide: true },
    (err, stdout, stderr) => {
      let account: string | undefined
      try { account = JSON.parse(String(stdout)).Account } catch { /* none */ }
      resolve({ ok: !err && /^\d{12}$/.test(account ?? ''), account, stderr: String(stderr) })
    }))
}

/** Every profile with its label and status, by one free STS call each; run on the slow refresh only. */
export async function awsProfiles(now = Date.now()): Promise<AwsProfile[]> {
  const labels = readLabels(), { chrome } = readPrefs()
  return Promise.all(parseAwsConfig(readAwsConfig()).map(async s => {
    const r = await check(s.name)
    const account = (r.ok ? r.account : undefined) ?? accountOf(s.values)
    const label = (account && labels[account]) || labels[`profile:${s.name}`]
    return {
      name: s.name, isDefault: s.isDefault, status: awsStatus(r.ok, r.stderr, s.values), checkedAt: now,
      ...(account ? { account } : {}), ...(label ? { label } : {}), ...(s.values.region ? { region: s.values.region } : {}),
      ...(chrome[s.name] !== undefined ? { chrome: chrome[s.name] } : {}),
    }
  }))
}
