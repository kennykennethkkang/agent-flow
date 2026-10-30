import type { HubState, Installed } from './hub-types'

/** tips: each name's description, same order as names. */
export type GearRow = { label: string; hint: string; names: string[]; tips: (string | undefined)[]; match: boolean }
// skills: plugin:skill, the form Claude Code names them in.
type Entry = { text: string; key: string; skills?: string[]; tip?: string }

const short = (i: Installed) => i.name.split('@')[0]

/** The gear's lists of installed things. q is lower case; while set, a row keeps only the names that match. */
export function gearRows(hub: Pick<HubState, 'installed' | 'connections'>, q: string): GearRow[] {
  const of = (kind: Installed['kind'], enabled?: boolean) => hub.installed.filter(i => i.kind === kind && (enabled === undefined || i.enabled === enabled))
  const plain = (items: Installed[]): Entry[] => items.map(i => ({ text: short(i), key: i.name, tip: i.description }))
  const marked = (items: Installed[]): Entry[] => items.map(i => {
    const notes = [i.skills?.length && String(i.skills.length), !i.enabled && 'off'].filter(Boolean).join(', ')
    return { text: `${short(i)}${notes ? ` (${notes})` : ''}`, key: i.name, skills: (i.skills ?? []).map(s => `${short(i)}:${s}`), tip: i.description }
  })
  const mcp = [...new Set(hub.connections.filter(c => c.kind === 'mcp').map(c => c.name))]
  const lists: Array<[string, string, Entry[]]> = [
    ['Roles', 'role', plain(of('role'))],
    ['Skills', 'skill', plain(of('skill', true))],
    ['Archived skills', 'skill', plain(of('skill', false))],
    ['Plugins', 'plugin', marked(of('plugin'))],
    ['Mods', 'mod', marked(of('mod'))],
    ['MCP servers', 'server', mcp.map(n => ({ text: n, key: n }))],
    ['Jev presets', 'preset', plain(of('preset'))],
    ['Design references', 'reference', plain(of('asset'))],
  ]
  // Design references only show once a project has some.
  return lists.filter(([, word, entries]) => word !== 'reference' || entries.length).map(([label, word, entries]) => {
    const hint = `${entries.length} ${word}${entries.length === 1 ? '' : 's'}`
    const whole = `${label} ${hint}`.toLowerCase().includes(q)
    const shown = entries.flatMap(e => {
      const self = e.key.toLowerCase().includes(q) || !!q && !!e.tip?.toLowerCase().includes(q)
      const hits = q && !self ? (e.skills ?? []).filter(s => s.toLowerCase().includes(q)).map(s => s.slice(s.indexOf(':') + 1)) : []
      if (hits.length) return [{ name: `${e.text}: ${hits.join(', ')}`, tip: e.tip }]
      return whole || self ? [{ name: e.text, tip: e.tip }] : []
    })
    return { label, hint, names: shown.map(x => x.name), tips: shown.map(x => x.tip), match: whole || shown.length > 0 }
  })
}

/** Each role's model as it runs: its frontmatter model, or the lead's for inherit (and no line, which Claude Code reads as inherit). */
export function roleModels(installed: Installed[], lead?: string): Record<string, string> {
  return Object.fromEntries(installed.filter(i => i.kind === 'role').map(i => [i.name, !i.model || i.model === 'inherit' ? lead ?? 'inherit' : i.model]))
}
