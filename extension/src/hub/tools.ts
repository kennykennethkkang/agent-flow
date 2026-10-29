/**
 * Each chat's own plugins and skills: picked from its goal by one quick model call, saved under
 * ~/.claude/switchboard/chat-profiles/<session id>.json with the settings file made from it
 * (<session id>.settings.json), which the chat starts and resumes with (--settings).
 * enabledPlugins there merges per key, so every plugin is written out; skillOverrides only
 * hides user skills, plugin skills go with their plugin. Mods are never touched.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ChatProfile, Installed } from './types'

export const PROFILES = path.join(os.homedir(), '.claude', 'switchboard', 'chat-profiles')
// Scan-flagged: a pick never turns these on; Kenneth can, per chat.
export const FLAGGED = ['auth0@claude-plugins-official', 'stitch-build@google-labs-code-stitch-skills', 'stitch-design@google-labs-code-stitch-skills', 'stitch-utilities@google-labs-code-stitch-skills']
// Plugins every chat keeps, by the name before the @.
export const ALWAYS = ['superpowers', 'ponytail', 'code-review', 'context7', 'playwright']
export const PICK_MS = 20000
/** Appended to a profiled chat's system prompt, so it asks instead of working around a missing tool. */
export const TOOLS_NOTE = 'Switchboard started this chat with a set of plugins and skills picked for its goal. If you need a plugin or skill that is off, say which one and why in one line instead of working around it. Never turn on a flagged plugin yourself.'

const short = (id: string) => id.split('@')[0]
const plugins = (inv: Installed[]) => inv.filter(i => i.kind === 'plugin')
// Archived skills cannot load anyway, so only ~/.claude/skills counts.
const skills = (inv: Installed[]) => inv.filter(i => i.kind === 'skill' && i.enabled)
const fix = (id: string, on: boolean) => (ALWAYS.includes(short(id)) ? true : FLAGGED.includes(id) ? false : on)

/** What a chat gets with no pick: the user's settings, core plugins on, flagged off. */
export function defaultProfile(inv: Installed[]): ChatProfile {
  return {
    plugins: Object.fromEntries(plugins(inv).map(p => [p.name, fix(p.name, p.enabled)])),
    skills: Object.fromEntries(skills(inv).map(s => [s.name, true])),
  }
}

/** A profile sent by the panel: only installed names, gaps from the defaults; a flagged plugin turned on by hand stays on, an ALWAYS one cannot be turned off. */
export function cleanProfile(p: ChatProfile, inv: Installed[]): ChatProfile {
  const d = defaultProfile(inv)
  const pick = (from: Record<string, boolean>, base: Record<string, boolean>) =>
    Object.fromEntries(Object.entries(base).map(([k, v]) => [k, typeof from[k] === 'boolean' && !ALWAYS.includes(short(k)) ? from[k] : v]))
  return { plugins: pick(p.plugins ?? {}, d.plugins), skills: pick(p.skills ?? {}, d.skills) }
}

export function pickPrompt(goal: string, inv: Installed[]): string {
  const line = (i: Installed) => `- ${i.name}${i.description ? `: ${i.description}` : ''}${i.skills?.length ? ` (skills: ${i.skills.slice(0, 8).join(', ')})` : ''}`
  return [
    'Pick the Claude Code plugins and skills this coding task needs. Leave out what it clearly does not need.',
    'Answer with JSON only: {"plugins":["id",...],"skills":["name",...]}',
    '', `Task: ${goal.slice(0, 600)}`,
    '', 'Plugins:', ...plugins(inv).filter(p => !FLAGGED.includes(p.name) && !ALWAYS.includes(short(p.name))).map(line),
    '', 'Skills:', ...skills(inv).map(line),
  ].join('\n')
}

/** The model's answer as a profile: named ones on, the rest off; undefined when it is not the JSON asked for. */
export function parsePick(answer: string, inv: Installed[]): ChatProfile | undefined {
  const m = /\{[\s\S]*\}/.exec(answer)
  let j: { plugins?: unknown; skills?: unknown }
  try { j = JSON.parse(m?.[0] ?? '') } catch { return undefined }
  const names = (v: unknown) => (Array.isArray(v) && v.every(x => typeof x === 'string') ? new Set(v as string[]) : undefined)
  const ps = names(j.plugins), ss = names(j.skills)
  if (!ps || !ss) return undefined
  return {
    plugins: Object.fromEntries(plugins(inv).map(p => [p.name, fix(p.name, ps.has(p.name) || ps.has(short(p.name)))])),
    skills: Object.fromEntries(skills(inv).map(s => [s.name, ss.has(s.name)])),
  }
}

/** Same wait as titleFor; slow, failed or unreadable, the defaults. */
export async function pickProfile(goal: string, inv: Installed[], ask: (prompt: string, ms: number) => Promise<string>, ms = PICK_MS): Promise<ChatProfile> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>(r => { timer = setTimeout(() => r(undefined), ms) })
  const answer = await Promise.race([ask(pickPrompt(goal, inv), ms).catch(() => undefined), timeout])
  clearTimeout(timer)
  return (answer ? parsePick(answer, inv) : undefined) ?? defaultProfile(inv)
}

export const profileSettings = (p: ChatProfile) => ({
  enabledPlugins: { ...p.plugins },
  skillOverrides: Object.fromEntries(Object.entries(p.skills).filter(([, on]) => !on).map(([k]) => [k, 'off'])),
})

const ID = /^[0-9a-f-]{8,64}$/i
const fileOf = (id: string, dir: string, ext = 'json') => {
  if (!ID.test(id)) throw new Error('Not a chat id')
  return path.join(dir, `${id}.${ext}`)
}

/** Writes the profile and the settings file made from it; returns the settings file's path. */
export function saveProfile(id: string, p: ChatProfile, dir = PROFILES): string {
  const file = fileOf(id, dir, 'settings.json')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(fileOf(id, dir), `${JSON.stringify(p, null, 2)}\n`)
  fs.writeFileSync(file, `${JSON.stringify(profileSettings(p), null, 2)}\n`)
  return file
}

/** Saved profiles by session id; ids without one are left out. */
export function readProfiles(ids: string[], dir = PROFILES): Record<string, ChatProfile> {
  const out: Record<string, ChatProfile> = {}
  for (const id of new Set(ids)) {
    if (!ID.test(id)) continue
    try {
      const p = JSON.parse(fs.readFileSync(fileOf(id, dir), 'utf8')) as ChatProfile
      if (p && typeof p.plugins === 'object' && typeof p.skills === 'object') out[id] = p
    } catch { /* no profile */ }
  }
  return out
}

/** ` --settings '<file>'` for a chat that has a profile, else ''. */
export function resumeSettingsArg(id: string, dir = PROFILES): string {
  if (!ID.test(id)) return ''
  const file = fileOf(id, dir, 'settings.json')
  return fs.existsSync(file) ? ` --settings '${file.replace(/'/g, `'\\''`)}'` : ''
}
