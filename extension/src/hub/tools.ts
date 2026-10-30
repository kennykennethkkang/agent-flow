/**
 * Each chat's own plugins and skills: all on, then one quick model call turns off what its goal does not need, saved under
 * ~/.claude/switchboard/chat-profiles/<session id>.json with the settings file made from it
 * (<session id>.settings.json), which the chat starts and resumes with (--settings).
 * enabledPlugins there merges per key, so every plugin is written out; skillOverrides only
 * hides user and project skills, plugin skills go with their plugin. Mods are never touched.
 * Design references (assets) left on are named to the chat in its appended system note, to read before UI work.
 * The bundled design library (source 'library', absolute paths) is the opposite: off unless the pick names it.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SHELL, shellQuote, type Shell } from './projects'
import type { ChatProfile, Installed } from './types'

export const PROFILES = path.join(os.homedir(), '.claude', 'switchboard', 'chat-profiles')
// A pick never turns these on; Kenneth can, per chat. Empty since auth0 and Stitch were audited; paid-guard asks before a Stitch upload.
export const FLAGGED: string[] = []
// Plugins every chat keeps, by the name before the @.
export const ALWAYS = ['superpowers', 'ponytail', 'code-review', 'context7', 'playwright']
export const PICK_MS = 20000
export const PROMPT_MAX = 8000
const DESC = 100
const MAX_LIBRARY = 3
/** Appended to a profiled chat's system prompt, so it asks instead of working around a missing tool. */
export const TOOLS_NOTE = 'Switchboard started this chat with every plugin and skill on, minus those its goal does not need. If you need a plugin or skill that is off, say which one and why in one line instead of working around it. Never turn on a flagged plugin yourself.'

const short = (id: string) => id.split('@')[0]
const plugins = (inv: Installed[]) => inv.filter(i => i.kind === 'plugin')
// Archived skills cannot load anyway, so only ~/.claude/skills counts.
const skills = (inv: Installed[]) => inv.filter(i => i.kind === 'skill' && i.enabled)
const isLib = (i: Installed) => i.source === 'library'
const allAssets = (inv: Installed[]) => inv.filter(i => i.kind === 'asset' && i.path)
const assets = (inv: Installed[]) => allAssets(inv).filter(i => !isLib(i))
const library = (inv: Installed[]) => allAssets(inv).filter(isLib)
// Only a chat with design references or the library gets an assets map.
const assetMap = (inv: Installed[], on: (a: Installed) => boolean) => {
  const as = allAssets(inv)
  return as.length ? { assets: Object.fromEntries(as.map(a => [a.path!, on(a)])) } : {}
}
const fix = (id: string, on: boolean) => (ALWAYS.includes(short(id)) ? true : FLAGGED.includes(id) ? false : on)

/** What a chat gets with no pick: everything on but flagged plugins and the library. */
export function defaultProfile(inv: Installed[]): ChatProfile {
  return {
    plugins: Object.fromEntries(plugins(inv).map(p => [p.name, fix(p.name, true)])),
    skills: Object.fromEntries(skills(inv).map(s => [s.name, true])),
    ...assetMap(inv, a => !isLib(a)),
  }
}

/** A profile sent by the panel: only installed names, gaps from the defaults; a flagged plugin turned on by hand stays on, an ALWAYS one cannot be turned off. */
export function cleanProfile(p: ChatProfile, inv: Installed[]): ChatProfile {
  const d = defaultProfile(inv)
  const pick = (from: Record<string, boolean>, base: Record<string, boolean>) =>
    Object.fromEntries(Object.entries(base).map(([k, v]) => [k, typeof from[k] === 'boolean' && !ALWAYS.includes(short(k)) ? from[k] : v]))
  return { plugins: pick(p.plugins ?? {}, d.plugins), skills: pick(p.skills ?? {}, d.skills), ...(d.assets ? { assets: pick(p.assets ?? {}, d.assets) } : {}) }
}

/** context: projectContext() of the chat's folder. Past PROMPT_MAX, library then asset descriptions go first, then the rest. */
export function pickPrompt(goal: string, inv: Installed[], context = ''): string {
  const build = (desc: number, assetDesc: number, libDesc: number) => {
    const line = (d: number) => (i: Installed) => `- ${i.name}${d && i.description ? `: ${i.description.slice(0, d)}` : ''}${d && i.skills?.length ? ` (skills: ${i.skills.slice(0, 5).join(', ')})` : ''}`
    const as = assets(inv), lib = library(inv)
    return [
      'Every Claude Code plugin, skill and design reference below starts on. Name the ones to turn off because this coding task clearly will not use them; everything left on costs context in every turn. When unsure, keep it on.',
      'For UI, styling or visual work, keep the design plugins and skills (impeccable, frontend-design, design and animation skills) and every design reference on.',
      'Turn off tool-specific plugins and skills (claude-x-jev and jev-*, aws-*, voice or phone agents, marketing) unless the task names that tool or job.',
      'Turn off design references for work with no UI.',
      ...(lib.length
        ? [`The design library starts off. For UI work that names or fits one of those looks, turn on up to ${MAX_LIBRARY} in "library"; else leave it empty.`,
            'Answer with JSON only, the names to turn off, then library names to turn on: {"plugins":["id",...],"skills":["name",...],"assets":["name",...],"library":["name",...]}']
        : ['Answer with JSON only, the names to turn off: {"plugins":["id",...],"skills":["name",...],"assets":["name",...]}']),
      '', `Task: ${goal.slice(0, 600)}`,
      ...(context ? ['', 'Project:', context.slice(0, 2000)] : []),
      '', 'Plugins:', ...plugins(inv).filter(p => !FLAGGED.includes(p.name) && !ALWAYS.includes(short(p.name))).map(line(desc)),
      '', 'Skills:', ...skills(inv).map(line(desc)),
      ...(as.length ? ['', 'Design references:', ...as.map(line(assetDesc))] : []),
      ...(lib.length ? ['', 'Design library:', ...lib.map(line(libDesc))] : []),
    ].join('\n')
  }
  const tiers: [number, number, number][] = [[DESC, 60, 60], [DESC, 60, 0], [DESC, 0, 0], [60, 0, 0], [40, 0, 0], [0, 0, 0]]
  const fits = tiers.map(([d, a, l]) => build(d, a, l)).find(t => t.length <= PROMPT_MAX)
  return fits ?? build(0, 0, 0).slice(0, PROMPT_MAX)
}

/** The model's answer as a profile: named ones off, the rest on, library only as named; undefined when it is not the JSON asked for. */
export function parsePick(answer: string, inv: Installed[]): ChatProfile | undefined {
  const m = /\{[\s\S]*\}/.exec(answer)
  let j: { plugins?: unknown; skills?: unknown; assets?: unknown; library?: unknown }
  try { j = JSON.parse(m?.[0] ?? '') } catch { return undefined }
  const names = (v: unknown) => (Array.isArray(v) && v.every(x => typeof x === 'string') ? new Set(v as string[]) : undefined)
  const ps = names(j.plugins), ss = names(j.skills)
  if (!ps || !ss) return undefined
  // By name or path; library in the model's order, first few only.
  const paths = (v: unknown, as: Installed[]) => [...(names(v) ?? [])].flatMap(n => as.filter(a => a.name === n || a.path === n).map(a => a.path!))
  const off = new Set(paths(j.assets, assets(inv))), on = new Set(paths(j.library, library(inv)).slice(0, MAX_LIBRARY))
  return {
    plugins: Object.fromEntries(plugins(inv).map(p => [p.name, fix(p.name, !ps.has(p.name) && !ps.has(short(p.name)))])),
    skills: Object.fromEntries(skills(inv).map(s => [s.name, !ss.has(s.name)])),
    ...assetMap(inv, a => (isLib(a) ? on.has(a.path!) : !off.has(a.path!))),
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

/** A Switchboard chat's starting profile: the panel's, else a pick for the goal, else the defaults (no model call); none with nothing installed. */
export async function startProfile(inv: Installed[], sent: ChatProfile | undefined, goal: string | undefined, pick: (goal: string) => Promise<ChatProfile>): Promise<ChatProfile | undefined> {
  if (!inv.length) return undefined
  return sent ? cleanProfile(sent, inv) : goal ? pick(goal) : defaultProfile(inv)
}

/** The gear's "Your name": one line, no quotes or shell characters, at most 40 chars; empty is off. */
export const cleanName = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').replace(/[\p{Cc}'"`$;\u2018-\u201F]/gu, '').replace(/ +/g, ' ').trim().slice(0, 40).trim() : '')

/** Appended to every chat Switchboard starts or resumes once a name is set. */
export function nameNote(name: string): string | undefined {
  const n = cleanName(name)
  return n ? `Address the user as ${n}. Speak to ${n} like a composed, quietly witty personal AI aide: brief, warm, capable. Use the name when talking to ${n} directly, not in every line. This is for chat replies only, never files, code or commits, and it never overrides the rules or formats the user set.` : undefined
}

/** TOOLS_NOTE plus the design references left on, for --append-system-prompt. */
export function toolsNote(p: ChatProfile): string {
  const refs = Object.entries(p.assets ?? {}).filter(([, on]) => on).map(([k]) => k)
  return refs.length ? `${TOOLS_NOTE} Before any UI, styling or web design work, read these design references first: ${refs.join(', ')}.` : TOOLS_NOTE
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

// --settings outranks ~/.claude/settings.json, so this turns auto-connect off for one chat and leaves the user's choice alone.
const NO_REMOTE = { remoteControlAtStartup: false }
const NO_REMOTE_ARG = JSON.stringify(NO_REMOTE)

/** A chat that must never connect to Remote Control (a To-do run) has an empty <id>.noremote here; every writer and reader checks it. */
export const isNoRemote = (id: string, dir = PROFILES) => ID.test(id) && fs.existsSync(fileOf(id, dir, 'noremote'))
function markNoRemote(id: string, dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(fileOf(id, dir, 'noremote'), '')
}

/** Writes the profile and the settings file made from it, Remote Control off for a no-remote chat; returns the settings file's path. */
export function saveProfile(id: string, p: ChatProfile, dir = PROFILES): string {
  const file = fileOf(id, dir, 'settings.json')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(fileOf(id, dir), `${JSON.stringify(p, null, 2)}\n`)
  fs.writeFileSync(file, `${JSON.stringify({ ...profileSettings(p), ...(isNoRemote(id, dir) ? NO_REMOTE : {}) }, null, 2)}\n`)
  return file
}

/** A new chat's --settings: its profile's file, else the off switch inline for a no-remote chat. noRemote marks the chat for good. */
export function chatSettings(id: string | undefined, p: ChatProfile | undefined, noRemote = false, dir = PROFILES): string | undefined {
  if (id && noRemote) markNoRemote(id, dir)
  if (id && p) return saveProfile(id, p, dir)
  return noRemote || (id && isNoRemote(id, dir)) ? NO_REMOTE_ARG : undefined
}

/** A handoff's fresh chat takes the old one's tools and its Remote Control switch. off: start it without --remote-control too. */
export function handoffSettings(from: string, to: string, p: ChatProfile | undefined, dir = PROFILES): { settings?: string; off: boolean } {
  const off = isNoRemote(from, dir)
  return { settings: chatSettings(to, p, off, dir), off }
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

/** ` --settings '<file>'` for a chat that has a profile, the off switch inline for a no-remote one without, else ''; with picked design references or extra (the name note), --append-system-prompt too. */
export function resumeSettingsArg(id: string, dir = PROFILES, extra = '', shell: Shell = SHELL): string {
  if (!ID.test(id)) return ''
  const file = fileOf(id, dir, 'settings.json')
  const has = fs.existsSync(file)
  const p = has ? readProfiles([id], dir)[id] : undefined
  const note = p ? toolsNote(p) : TOOLS_NOTE
  const append = [note === TOOLS_NOTE ? '' : note, extra].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  const settings = has ? file : isNoRemote(id, dir) ? NO_REMOTE_ARG : undefined
  return `${settings ? ` --settings ${shellQuote(settings, shell)}` : ''}${append ? ` --append-system-prompt ${shellQuote(append, shell)}` : ''}`
}
