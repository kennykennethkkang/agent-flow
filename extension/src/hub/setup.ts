/**
 * Set up: the steps that give a new machine the plugins, mods, MCP servers and skills (kit/setup.json).
 * Each step is left out when that piece is already there. No vscode here.
 */
import * as fs from 'fs'
import * as path from 'path'

export type SetupKit = {
  marketplaces: Record<string, string>
  plugins: string[]
  mods: string[]
  /** keyHeader: the server needs the 21st key, sent in this header. */
  mcps: { name: string; url: string; keyHeader?: string }[]
  /** Fetched from GitHub into ~/.claude/skills; names are SKILL.md names, not folder names. */
  skills?: SkillRepo[]
}
export type SkillRepo = { repo: string; names: string[] }
/** What the machine has: plugin ids, marketplace names, user-scope MCP server names, ~/.claude/skills folders; plain: those holding a literal header, left out of mcps. */
export type SetupState = { plugins: string[]; marketplaces: string[]; mcps: string[]; plain: string[]; skills: string[] }

/** The terminal's env carries the key; kit/setup-run.mjs moves it to the OS secret store, never into a command or config. */
export const KEY_ENV = 'API_KEY_21ST'
const MODS = '~/.claude/switchboard/mods'
const ASK = '~/.claude/switchboard/ask/ask-server.mjs'

/** One step for kit/setup-run.mjs: say a line, or copy then run, only when ifExists is there; key: store the key and add that server; skills: clone the repo and copy those in. ~/ is the home folder. */
export type SetupStep = { label?: string; say?: string; ifExists?: string; copy?: { from: string; to: string }; run?: string[]; quiet?: true; key?: { name: string; url: string; header: string }; skills?: SkillRepo }

/** key21st: whether the env holds the key. modsDir: the bundled marketplace, copied out since the extension folder moves on update. */
export function setupSteps(kit: SetupKit, o: SetupState & { key21st: boolean; modsDir: string; platform?: NodeJS.Platform }): SetupStep[] {
  const out: SetupStep[] = []
  const claude = (label: string, ...args: string[]) => out.push({ label, run: ['claude', ...args] })
  for (const [name, repo] of Object.entries(kit.marketplaces)) if (!o.marketplaces.includes(name)) claude(name, 'plugin', 'marketplace', 'add', repo)
  const copy = { from: o.modsDir, to: MODS }
  if (!o.marketplaces.includes('kenneth-mods')) out.push({ label: 'Mods', copy, run: ['claude', 'plugin', 'marketplace', 'add', MODS] })
  // Our own copy gets this version's mods; a kenneth-mods pointing elsewhere (a claude-mods clone) is left alone.
  else out.push({ label: 'Refresh mods', ifExists: MODS, copy, run: ['claude', 'plugin', 'marketplace', 'update', 'kenneth-mods'] })
  for (const id of [...kit.plugins, ...kit.mods.map(m => `${m}@kenneth-mods`)]) if (!o.plugins.includes(id)) claude(id, 'plugin', 'install', id)
  for (const m of kit.mcps) {
    // A new key always goes to the store; a plain-text one is moved there without asking, except on linux, which has no store.
    if (m.keyHeader && (o.key21st || (o.plain.includes(m.name) && (o.platform ?? process.platform) !== 'linux'))) { out.push({ label: m.name, key: { name: m.name, url: m.url, header: m.keyHeader } }); continue }
    if (o.mcps.includes(m.name)) continue
    if (!m.keyHeader) out.push({ label: m.name, run: ['claude', 'mcp', 'add', '--scope', 'user', '--transport', 'http', m.name, m.url] })
    else out.push({ say: `${m.name}: no key given, skipped. Get one at https://21st.dev/mcp and run Set up again.` })
  }
  for (const k of kit.skills ?? []) {
    const names = k.names.filter(n => !o.skills.includes(n))
    if (names.length) out.push({ label: k.repo, skills: { repo: k.repo, names } })
  }
  if (!o.mcps.includes('switchboard')) out.push({ label: 'Ask tool', ifExists: ASK, run: ['claude', 'mcp', 'add', '--scope', 'user', 'switchboard', '--', 'node', ASK] })
  out.push({ say: '' }, { say: 'Set up done. Sign in to Slack with /mcp in a chat, then run /reload-plugins in chats that were already open.' })
  return out
}

const names = (file: string, pick: (j: Record<string, unknown>) => unknown) => {
  try { return Object.keys((pick(JSON.parse(fs.readFileSync(file, 'utf8'))) ?? {}) as object) } catch { return [] }
}

/** A server whose headers hold a literal value, as Set up before 0.18 wrote the 21st key; it counts as missing so a rerun replaces it. */
const plain = (m: unknown) => Object.values((m as { headers?: object })?.headers ?? {}).some(v => typeof v === 'string' && !v.includes('${'))

export function setupState(home: string): SetupState {
  const plugins = path.join(home, '.claude', 'plugins')
  const plainOnes = names(path.join(home, '.claude.json'), j => Object.fromEntries(Object.entries((j.mcpServers ?? {}) as object).filter(([, m]) => plain(m))))
  return {
    plugins: names(path.join(plugins, 'installed_plugins.json'), j => j.plugins),
    marketplaces: names(path.join(plugins, 'known_marketplaces.json'), j => j),
    mcps: names(path.join(home, '.claude.json'), j => j.mcpServers).filter(n => !plainOnes.includes(n)),
    plain: plainOnes,
    skills: fs.existsSync(path.join(home, '.claude', 'skills')) ? fs.readdirSync(path.join(home, '.claude', 'skills')).filter(n => !n.startsWith('.')) : [],
  }
}

/** claude is claude.cmd on Windows, which runs only through a shell; args with spaces or quotes are quoted for it. */
export function claudeCall(args: string[], platform: NodeJS.Platform = process.platform): { cmd: string; args: string[]; shell: boolean } {
  if (platform !== 'win32') return { cmd: 'claude', args, shell: false }
  // Backslashes before a quote, or the closing one, double.
  return { cmd: 'claude', args: args.map(a => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"` : a)), shell: true }
}
