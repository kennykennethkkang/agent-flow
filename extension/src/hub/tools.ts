/**
 * Each chat's own plugins and skills: picked from its goal by one quick model call, saved under
 * ~/.claude/switchboard/chat-profiles/<session id>.json with the settings file made from it
 * (<session id>.settings.json), which the chat starts and resumes with (--settings).
 * enabledPlugins there merges per key, so every plugin is written out; skillOverrides only
 * hides user and project skills, plugin skills go with their plugin. Mods are never touched.
 * Picked design references (assets) are named to the chat in its appended system note.
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
export const PROMPT_MAX = 8000
const DESC = 100
const MAX_ASSETS = 3
/** Appended to a profiled chat's system prompt, so it asks instead of working around a missing tool. */
export const TOOLS_NOTE = 'Switchboard started this chat with a set of plugins and skills picked for its goal. If you need a plugin or skill that is off, say which one and why in one line instead of working around it. Never turn on a flagged plugin yourself.'

const short = (id: string) => id.split('@')[0]
const plugins = (inv: Installed[]) => inv.filter(i => i.kind === 'plugin')
// Archived skills cannot load anyway, so only ~/.claude/skills counts.
const skills = (inv: Installed[]) => inv.filter(i => i.kind === 'skill' && i.enabled)
const assets = (inv: Installed[]) => inv.filter(i => i.kind === 'asset' && i.path)
// Only a project with design references gets an assets map.
const assetMap = (inv: Installed[], on: (path: string) => boolean) => {
  const as = assets(inv)
  return as.length ? { assets: Object.fromEntries(as.map(a => [a.path!, on(a.path!)])) } : {}
}
const fix = (id: string, on: boolean) => (ALWAYS.includes(short(id)) ? true : FLAGGED.includes(id) ? false : on)

/** What a chat gets with no pick: the user's settings, core plugins on, flagged off. */
export function defaultProfile(inv: Installed[]): ChatProfile {
  return {
    plugins: Object.fromEntries(plugins(inv).map(p => [p.name, fix(p.name, p.enabled)])),
    skills: Object.fromEntries(skills(inv).map(s => [s.name, true])),
    ...assetMap(inv, () => false),
  }
}

/** A profile sent by the panel: only installed names, gaps from the defaults; a flagged plugin turned on by hand stays on, an ALWAYS one cannot be turned off. */
export function cleanProfile(p: ChatProfile, inv: Installed[]): ChatProfile {
  const d = defaultProfile(inv)
  const pick = (from: Record<string, boolean>, base: Record<string, boolean>) =>
    Object.fromEntries(Object.entries(base).map(([k, v]) => [k, typeof from[k] === 'boolean' && !ALWAYS.includes(short(k)) ? from[k] : v]))
  return { plugins: pick(p.plugins ?? {}, d.plugins), skills: pick(p.skills ?? {}, d.skills), ...(d.assets ? { assets: pick(p.assets ?? {}, d.assets) } : {}) }
}

/** context: projectContext() of the chat's folder. Past PROMPT_MAX, asset descriptions go first, then the rest. */
export function pickPrompt(goal: string, inv: Installed[], context = ''): string {
  const build = (desc: number, assetDesc: number) => {
    const line = (d: number) => (i: Installed) => `- ${i.name}${d && i.description ? `: ${i.description.slice(0, d)}` : ''}${d && i.skills?.length ? ` (skills: ${i.skills.slice(0, 5).join(', ')})` : ''}`
    const as = assets(inv)
    return [
      'Pick the Claude Code plugins, skills and design references this coding task needs. Pick only what the task needs; everything picked costs context in every turn.',
      'For UI, styling or visual work, pick the design plugins and skills (impeccable, frontend-design, design and animation skills).',
      'Leave out tool-specific plugins and skills (claude-x-jev and jev-*, aws-*, voice or phone agents, marketing) unless the task names that tool or job.',
      `Design references: pick up to ${MAX_ASSETS} only for UI work that names or fits that look, else none.`,
      'Answer with JSON only: {"plugins":["id",...],"skills":["name",...],"assets":["name",...]}',
      '', `Task: ${goal.slice(0, 600)}`,
      ...(context ? ['', 'Project:', context.slice(0, 2000)] : []),
      '', 'Plugins:', ...plugins(inv).filter(p => !FLAGGED.includes(p.name) && !ALWAYS.includes(short(p.name))).map(line(desc)),
      '', 'Skills:', ...skills(inv).map(line(desc)),
      ...(as.length ? ['', 'Design references:', ...as.map(line(assetDesc))] : []),
    ].join('\n')
  }
  const tiers: [number, number][] = [[DESC, 60], [DESC, 0], [60, 0], [40, 0], [0, 0]]
  const fits = tiers.map(([d, a]) => build(d, a)).find(t => t.length <= PROMPT_MAX)
  return fits ?? build(0, 0).slice(0, PROMPT_MAX)
}

/** The model's answer as a profile: named ones on, the rest off; undefined when it is not the JSON asked for. */
export function parsePick(answer: string, inv: Installed[]): ChatProfile | undefined {
  const m = /\{[\s\S]*\}/.exec(answer)
  let j: { plugins?: unknown; skills?: unknown; assets?: unknown }
  try { j = JSON.parse(m?.[0] ?? '') } catch { return undefined }
  const names = (v: unknown) => (Array.isArray(v) && v.every(x => typeof x === 'string') ? new Set(v as string[]) : undefined)
  const ps = names(j.plugins), ss = names(j.skills)
  if (!ps || !ss) return undefined
  // In the model's order, by name or path, first few only.
  const as = assets(inv)
  const picked = new Set([...(names(j.assets) ?? [])].flatMap(n => as.filter(a => a.name === n || a.path === n).map(a => a.path!)).slice(0, MAX_ASSETS))
  return {
    plugins: Object.fromEntries(plugins(inv).map(p => [p.name, fix(p.name, ps.has(p.name) || ps.has(short(p.name)))])),
    skills: Object.fromEntries(skills(inv).map(s => [s.name, ss.has(s.name)])),
    ...assetMap(inv, p => picked.has(p)),
  }
}

/**
 * Same wait as titleFor; slow, failed or unreadable, the defaults, told to onFallback.
 * The defaults are the user's own settings, what a chat started outside Switchboard gets, so a failed pick never strips a needed plugin.
 */
export async function pickProfile(goal: string, inv: Installed[], ask: (prompt: string, ms: number) => Promise<string>, ms = PICK_MS, onFallback: (why: string) => void = () => {}, context = ''): Promise<ChatProfile> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let why = `no answer in ${ms} ms`
  const timeout = new Promise<undefined>(r => { timer = setTimeout(() => r(undefined), ms) })
  const answer = await Promise.race([ask(pickPrompt(goal, inv, context), ms).catch(err => { why = String((err as Error)?.message ?? err).split('\n')[0]; return undefined }), timeout])
  clearTimeout(timer)
  const picked = answer ? parsePick(answer, inv) : undefined
  if (picked) return picked
  onFallback(answer ? `unreadable answer: ${answer.slice(0, 80)}` : why)
  return defaultProfile(inv)
}

/** TOOLS_NOTE plus the picked design references, for --append-system-prompt. */
export function toolsNote(p: ChatProfile): string {
  const refs = Object.entries(p.assets ?? {}).filter(([, on]) => on).map(([k]) => k)
  return refs.length ? `${TOOLS_NOTE} Design references picked for this chat: ${refs.join(', ')}.` : TOOLS_NOTE
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

/** ` --settings '<file>'` for a chat that has a profile, else ''; with picked design references, the note naming them too. */
export function resumeSettingsArg(id: string, dir = PROFILES): string {
  if (!ID.test(id)) return ''
  const file = fileOf(id, dir, 'settings.json')
  if (!fs.existsSync(file)) return ''
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const p = readProfiles([id], dir)[id]
  const note = p ? toolsNote(p) : TOOLS_NOTE
  return ` --settings ${quote(file)}${note === TOOLS_NOTE ? '' : ` --append-system-prompt ${quote(note.replace(/\s+/g, ' '))}`}`
}
