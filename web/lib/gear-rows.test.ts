import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gearRows, roleModels } from './gear-rows'
import type { Connection, Installed } from './hub-types'
import { demoHub } from './hub-demo'

const installed: Installed[] = [
  { kind: 'plugin', name: 'superpowers@superpowers-dev', enabled: true, skills: ['brainstorming', 'writing-plans'] },
  // code-review and codex ship commands only (commands/*.md); installed() lists them with the skills.
  { kind: 'plugin', name: 'code-review@claude-plugins-official', enabled: true, skills: ['code-review'] },
  { kind: 'plugin', name: 'codex@openai-codex', enabled: true, skills: ['rescue', 'setup'] },
  { kind: 'plugin', name: 'github@claude-plugins-official', enabled: false },
  { kind: 'mod', name: 'usage-meter@kenneth-mods', enabled: true },
  { kind: 'skill', name: 'phone', enabled: true }, { kind: 'skill', name: 'skill-inspector', enabled: true },
  { kind: 'skill', name: 'drei', enabled: false },
  { kind: 'role', name: 'qa', enabled: true }, { kind: 'role', name: 'engineer', enabled: true },
  { kind: 'preset', name: 'armasu-copy-check', enabled: true },
]
const connections: Connection[] = [{ kind: 'mcp', name: 'openrouter', status: 'on' }, { kind: 'mcp', name: 'openrouter', status: 'on', detail: 'x' }, { kind: 'repo', name: 'r', status: 'on' }]
const rows = (q: string) => Object.fromEntries(gearRows({ installed, connections }, q).filter(r => r.match).map(r => [r.label, r.names]))

test('with no query every row lists all its names with a count', () => {
  const all = gearRows({ installed, connections }, '')
  assert.deepEqual(all.map(r => [r.label, r.hint]), [
    ['Roles', '2 roles'], ['Skills', '2 skills'], ['Archived skills', '1 skill'], ['Plugins', '4 plugins'], ['Mods', '1 mod'], ['MCP servers', '1 server'], ['Jev presets', '1 preset'],
  ])
  assert.deepEqual(rows('').Plugins, ['superpowers (2)', 'code-review (1)', 'codex (2)', 'github (off)'])
  assert.deepEqual(rows('')['MCP servers'], ['openrouter'])
})

test('a query shows only the rows and names that match', () => {
  assert.deepEqual(rows('inspector'), { Skills: ['skill-inspector'] })
  assert.deepEqual(rows('qa'), { Roles: ['qa'] })
  assert.deepEqual(rows('copy'), { 'Jev presets': ['armasu-copy-check'] })
  assert.deepEqual(rows('router'), { 'MCP servers': ['openrouter'] })
})

test('plugin skills match by name and in the plugin:skill form', () => {
  assert.deepEqual(rows('brainstorming'), { Plugins: ['superpowers (2): brainstorming'] })
  assert.deepEqual(rows('superpowers:brainstorming'), { Plugins: ['superpowers (2): brainstorming'] })
  assert.deepEqual(rows('code-review:code-review'), { Plugins: ['code-review (1): code-review'] })
  assert.deepEqual(rows('codex:rescue'), { Plugins: ['codex (2): rescue'] })
  assert.deepEqual(rows('superpowers'), { Plugins: ['superpowers (2)'] })
})

test('a query that names the row itself keeps the whole list', () => {
  assert.deepEqual(rows('roles').Roles, ['qa', 'engineer'])
})

test('role models: the frontmatter model, or the lead model for inherit and no line', () => {
  const roles: Installed[] = [
    { kind: 'role', name: 'qa', enabled: true, model: 'opus' }, { kind: 'role', name: 'ops', enabled: true, model: 'inherit' },
    { kind: 'role', name: 'growth', enabled: true }, { kind: 'skill', name: 'phone', enabled: true, model: 'haiku' },
  ]
  assert.deepEqual(roleModels(roles, 'sonnet'), { qa: 'opus', ops: 'sonnet', growth: 'sonnet' })
  assert.deepEqual(roleModels(roles), { qa: 'opus', ops: 'inherit', growth: 'inherit' })
})

test('the demo roles carry models', () => {
  const h = demoHub(0)
  const m = roleModels(h.installed, h.controls.claude.model)
  assert.equal(m.engineer, 'opus')
  assert.ok(Object.keys(m).length >= 5)
})
