// The user's standing rules, enforced on the tool call instead of carried in memory.
// Each refusal is also reported to the Switchboard window for this folder.
import type { EngineInterface, Register } from 'claude-code'

// Built from its code point so this file holds no em dash itself.
export const EM = String.fromCharCode(0x2014)

const RULES: { test: RegExp; why: string; short: string }[] = [
  { test: /\bgit\b(\s+-[cC]\s+\S+)*\s+(commit|push)\b/, short: 'a git commit or push', why: 'The user commits and pushes themselves, from their own terminal or VS Code Source Control. Leave the work modified.' },
  { test: /\bgit\b(\s+-[cC]\s+\S+)*\s+rm\b[^|;&]*--cached/, short: 'git rm --cached', why: 'git rm --cached stages a deletion. Delete with plain rm; if the index was touched, git reset -q -- <paths>.' },
  { test: /\bprettier\b[^|;&]*\s(--write|-w)\b/, short: 'prettier --write', why: 'No formatter here: prettier --write rewraps whole files at 80 columns. Edit by hand.' },
]

const DASH = 'An em dash in the new text. Use a comma, a colon, or "to".'

export const bashRule = (command: string) => RULES.find(r => r.test.test(command))

const count = (s: string) => s.split(EM).length - 1
export const addsEmDash = (before: string, after: string) => count(after) > count(before)

export const norm = (p: string) => p.replace(/\\/g, '/')

/** New text under these folders gets no em dash: the repos and Claude's memory. */
export const rootsFor = (home: string) => [`${norm(home)}/Documents/GitHub/`, `${norm(home)}/.claude/projects/`]
export const isUnder = (path: string, roots: string[]) => roots.some(root => norm(path).startsWith(root))

// The home folder, read once; HOME on macOS and Linux, USERPROFILE on Windows.
const cache: { roots?: string[] } = {}

async function roots($: EngineInterface) {
  cache.roots ??= rootsFor((await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '')
  return cache.roots
}

/** Tells the Switchboard window for this folder; silent when there is none. */
async function report($: EngineInterface, detail: string) {
  const home = norm((await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '')
  const dir = `${home}/.claude/switchboard`
  const cwd = norm(await $.session.cwd())
  let best: { port: number; token: string; workspace: string } | undefined
  for (const e of await $.fs.list(dir).catch(() => [])) {
    if (e.kind !== 'file' || !e.name.endsWith('.json') || e.name === 'workspaces.json') continue
    try {
      const f = JSON.parse(String(await $.fs.read(`${dir}/${e.name}`)))
      const w = typeof f.workspace === 'string' ? norm(f.workspace).replace(/\/+$/, '') : ''
      if (typeof f.port !== 'number' || typeof f.hubToken !== 'string' || !w || (cwd !== w && !cwd.startsWith(`${w}/`))) continue
      if (!best || w.length > best.workspace.length) best = { port: f.port, token: f.hubToken, workspace: w }
    } catch { /* a file mid-write */ }
  }
  if (!best) return
  await $.http.fetch(`http://127.0.0.1:${best.port}/hub`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: best.token, kind: 'guard', mod: 'repo-rules', action: 'refused', detail }),
  }).catch(() => undefined)
}

const held = (what: string) => ({ deny: `repo-rules: the guard failed, so the ${what} was held.` })

async function checkBash($: EngineInterface, command: string) {
  const rule = bashRule(command)
  if (!rule) return undefined
  await report($, rule.short).catch(() => undefined)
  return { deny: `repo-rules: ${rule.why}` }
}

async function checkText($: EngineInterface, path: string, before: string, after: string) {
  if (!isUnder(path, await roots($)) || !addsEmDash(before, after)) return undefined
  await report($, `an em dash in ${path.split(/[\\/]/).pop()}`).catch(() => undefined)
  return { deny: `repo-rules: ${DASH}` }
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => (await checkBash($, e.command)) ?? next(e))
    .catch(($, e, next) => (next.called ? next(e) : held('command')))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => (await checkText($, e.file_path, e.old_string, e.new_string)) ?? next(e))
    .catch(($, e, next) => (next.called ? next(e) : held('edit')))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (!isUnder(e.file_path, await roots($))) return next(e)
    const before = await $.fs.read(e.file_path).catch(() => '')
    return (await checkText($, e.file_path, String(before), e.content)) ?? next(e)
  }).catch(($, e, next) => (next.called ? next(e) : held('write')))
}
