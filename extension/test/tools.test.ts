import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { Installed } from '../src/hub/types'
import { cleanProfile, defaultProfile, parsePick, pickProfile, pickPrompt, profileSettings, readProfiles, resumeSettingsArg, saveProfile } from '../src/hub/tools'

const inv: Installed[] = [
  { kind: 'plugin', name: 'superpowers@superpowers-dev', enabled: true, description: 'TDD and plans' },
  { kind: 'plugin', name: 'bland@bland', enabled: true, description: 'Voice agents' },
  { kind: 'plugin', name: 'marketing-skills@marketingskills', enabled: true },
  { kind: 'plugin', name: 'auth0@claude-plugins-official', enabled: false },
  { kind: 'plugin', name: 'aws-core@claude-plugins-official', enabled: false },
  { kind: 'mod', name: 'usage-meter@kenneth-mods', enabled: true },
  { kind: 'skill', name: 'phone', enabled: true, description: 'Call the owner' },
  { kind: 'skill', name: 'taste-design', enabled: true },
  { kind: 'skill', name: 'old-one', enabled: false },
  { kind: 'role', name: 'engineer', enabled: true },
]

test('defaultProfile: the user settings, mods and archived skills left out, flagged off', () => {
  assert.deepEqual(defaultProfile(inv), {
    plugins: { 'superpowers@superpowers-dev': true, 'bland@bland': true, 'marketing-skills@marketingskills': true, 'auth0@claude-plugins-official': false, 'aws-core@claude-plugins-official': false },
    skills: { phone: true, 'taste-design': true },
  })
  const on = defaultProfile([{ kind: 'plugin', name: 'auth0@claude-plugins-official', enabled: true }])
  assert.equal(on.plugins['auth0@claude-plugins-official'], false)
})

test('parsePick: named ones on, the rest off, always kept on, flagged never on', () => {
  const p = parsePick('Sure: {"plugins":["aws-core","auth0@claude-plugins-official"],"skills":["phone"]}', inv)!
  assert.deepEqual(p.plugins, { 'superpowers@superpowers-dev': true, 'bland@bland': false, 'marketing-skills@marketingskills': false, 'auth0@claude-plugins-official': false, 'aws-core@claude-plugins-official': true })
  assert.deepEqual(p.skills, { phone: true, 'taste-design': false })
})

test('parsePick: junk or no JSON is undefined', () => {
  assert.equal(parsePick('no idea', inv), undefined)
  assert.equal(parsePick('{"plugins":"all"}', inv), undefined)
  assert.equal(parsePick('{broken', inv), undefined)
})

test('cleanProfile: unknown names dropped, missing ones from defaults, a flagged one the user turned on kept', () => {
  const p = cleanProfile({ plugins: { 'auth0@claude-plugins-official': true, 'evil@x': true }, skills: { phone: false, nope: true } }, inv)
  assert.equal(p.plugins['auth0@claude-plugins-official'], true)
  assert.equal(p.plugins['evil@x'], undefined)
  assert.equal(p.plugins['bland@bland'], true)
  assert.deepEqual(p.skills, { phone: false, 'taste-design': true })
})

test('cleanProfile: an always-on plugin like superpowers stays on when turned off by hand', () => {
  assert.equal(cleanProfile({ plugins: { 'superpowers@superpowers-dev': false }, skills: {} }, inv).plugins['superpowers@superpowers-dev'], true)
})

test('pickPrompt: names the goal and every choice, not mods or roles', () => {
  const s = pickPrompt('make a phone agent', inv)
  assert.match(s, /make a phone agent/)
  assert.match(s, /bland@bland: Voice agents/)
  assert.match(s, /phone: Call the owner/)
  assert.doesNotMatch(s, /usage-meter|engineer|auth0/)
})

test('pickProfile: the answer when it parses, defaults when it fails or is slow', async () => {
  assert.equal((await pickProfile('x', inv, async () => '{"plugins":[],"skills":[]}')).plugins['bland@bland'], false)
  assert.deepEqual(await pickProfile('x', inv, async () => { throw new Error('x') }), defaultProfile(inv))
  assert.deepEqual(await pickProfile('x', inv, () => new Promise(r => setTimeout(() => r('{"plugins":[],"skills":[]}'), 50)), 10), defaultProfile(inv))
})

test('profileSettings: every plugin written out, only off skills overridden', () => {
  assert.deepEqual(profileSettings({ plugins: { 'a@b': true, 'c@d': false }, skills: { phone: false, x: true } }), {
    enabledPlugins: { 'a@b': true, 'c@d': false }, skillOverrides: { phone: 'off' },
  })
})

test('saveProfile and readProfiles round trip; resume finds the settings file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'))
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const p = { plugins: { 'a@b': false }, skills: { phone: false } }
  const file = saveProfile(id, p, dir)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), profileSettings(p))
  assert.deepEqual(readProfiles([id, 'missing'], dir), { [id]: p })
  assert.equal(resumeSettingsArg(id, dir), ` --settings '${file}'`)
  assert.equal(resumeSettingsArg('abc', dir), '')
  assert.throws(() => saveProfile('../x', p, dir))
})

test('routes: tool commands checked, a profile must be two maps of booleans', async () => {
  const { commandProblem } = await import('../src/hub/routes')
  const tools = { plugins: { 'a@b': true }, skills: {} }
  assert.equal(commandProblem({ type: 'hub-new-chat', path: '/p', remote: false, tools }), undefined)
  assert.equal(commandProblem({ type: 'hub-new-chat', path: '/p', remote: false }), undefined)
  assert.equal(commandProblem({ type: 'hub-pick-tools', text: 'x' }), undefined)
  assert.equal(commandProblem({ type: 'hub-chat-tools', sessionId: 'x', tools }), undefined)
  assert.ok(commandProblem({ type: 'hub-chat-tools', sessionId: 'x', tools: { plugins: { a: 'yes' }, skills: {} } }))
  assert.ok(commandProblem({ type: 'hub-new-chat', path: '/p', remote: false, tools: { plugins: [] } }))
})
