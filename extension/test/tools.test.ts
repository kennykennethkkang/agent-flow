import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { Installed } from '../src/hub/types'
import { FLAGGED, chatSettings, cleanName, handoffSettings, isNoRemote, nameNote, cleanProfile, defaultProfile, startProfile, parsePick, pickProfile, pickPrompt, profileSettings, readProfiles, resumeSettingsArg, saveProfile, toolsNote, TOOLS_NOTE, PROMPT_MAX } from '../src/hub/tools'

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

test('defaultProfile: every plugin on, mods and archived skills left out', () => {
  assert.deepEqual(defaultProfile(inv), {
    plugins: { 'superpowers@superpowers-dev': true, 'bland@bland': true, 'marketing-skills@marketingskills': true, 'auth0@claude-plugins-official': true, 'aws-core@claude-plugins-official': true },
    skills: { phone: true, 'taste-design': true },
  })
})

test('defaultProfile: nothing flagged, so auth0 and Stitch start on', () => {
  assert.deepEqual(FLAGGED, [])
  const all = defaultProfile(['auth0@claude-plugins-official', 'stitch-design@google-labs-code-stitch-skills'].map(name => ({ kind: 'plugin' as const, name, enabled: false })))
  assert.ok(Object.values(all.plugins).every(Boolean))
  const d = defaultProfile(FLAGGED.map(name => ({ kind: 'plugin' as const, name, enabled: true })))
  for (const name of FLAGGED) assert.equal(d.plugins[name], false, name)
})

test('startProfile: no goal is the defaults with no model call; nothing installed is none', async () => {
  const pick = async () => { throw new Error('no model call without a goal') }
  assert.deepEqual(await startProfile(inv, undefined, undefined, pick), defaultProfile(inv))
  assert.deepEqual(await startProfile(inv, undefined, '', pick), defaultProfile(inv))
  assert.equal(await startProfile([], undefined, 'build it', pick), undefined)
  const picked = { plugins: { 'bland@bland': false }, skills: {} }
  assert.equal(await startProfile(inv, undefined, 'build it', async g => (assert.equal(g, 'build it'), picked)), picked)
  const sent = await startProfile(inv, { plugins: { 'bland@bland': false }, skills: {} }, 'build it', pick)
  assert.deepEqual(sent, cleanProfile({ plugins: { 'bland@bland': false }, skills: {} }, inv))
})

test('parsePick: named ones off, the rest on, always kept on', () => {
  const p = parsePick('Sure: {"plugins":["aws-core","superpowers"],"skills":["phone"]}', inv)!
  assert.deepEqual(p.plugins, { 'superpowers@superpowers-dev': true, 'bland@bland': true, 'marketing-skills@marketingskills': true, 'auth0@claude-plugins-official': true, 'aws-core@claude-plugins-official': false })
  assert.deepEqual(p.skills, { phone: false, 'taste-design': true })
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
  assert.doesNotMatch(s, /usage-meter|engineer/)
  assert.match(s, /auth0@claude-plugins-official/)
})

test('pickProfile: the answer when it parses, defaults when it fails or is slow', async () => {
  assert.equal((await pickProfile('x', inv, async () => '{"plugins":["bland"],"skills":[]}')).plugins['bland@bland'], false)
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
  assert.equal(resumeSettingsArg(id, dir, '', 'posix'), ` --settings '${file}'`)
  assert.equal(resumeSettingsArg('abc', dir), '')
  assert.throws(() => saveProfile('../x', p, dir))
})

test('chatSettings: a to-do chat starts with Remote Control off, a normal new chat keeps the user setting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'))
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const p = { plugins: { 'a@b': true }, skills: {} }
  const off = chatSettings(id, p, true, dir)!
  assert.deepEqual(JSON.parse(fs.readFileSync(off, 'utf8')), { ...profileSettings(p), remoteControlAtStartup: false })
  const normal = chatSettings('1f8fad5b-d9cb-469f-a165-70867728950e', p, false, dir)!
  assert.deepEqual(JSON.parse(fs.readFileSync(normal, 'utf8')), profileSettings(p))
  assert.ok(!('remoteControlAtStartup' in profileSettings(p)))
  // No tool profile: the off switch goes inline, and a normal chat passes no --settings at all.
  assert.deepEqual(JSON.parse(chatSettings(undefined, undefined, true, dir)!), { remoteControlAtStartup: false })
  assert.equal(chatSettings(undefined, undefined, false, dir), undefined)
  assert.equal(chatSettings('2f8fad5b-d9cb-469f-a165-70867728950e', undefined, false, dir), undefined)
})

test('no remote is kept per chat: a tools change rewrites the settings with the switch still off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'))
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
  chatSettings(id, { plugins: {}, skills: {} }, true, dir)
  assert.equal(isNoRemote(id, dir), true)
  // saveChatTools writes through saveProfile with no switch of its own.
  const p = { plugins: { 'a@b': false }, skills: { phone: false } }
  const file = saveProfile(id, p, dir)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...profileSettings(p), remoteControlAtStartup: false })
  const other = '1f8fad5b-d9cb-469f-a165-70867728950e'
  assert.deepEqual(JSON.parse(fs.readFileSync(saveProfile(other, p, dir), 'utf8')), profileSettings(p))
  assert.equal(isNoRemote(other, dir), false)
  assert.equal(isNoRemote('../x', dir), false)
})

test('no remote on resume: with a profile its file, without one the switch inline, a normal chat neither', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'))
  const bare = '2f8fad5b-d9cb-469f-a165-70867728950e'
  chatSettings(bare, undefined, true, dir)
  assert.equal(resumeSettingsArg(bare, dir, '', 'posix'), ` --settings '{"remoteControlAtStartup":false}'`)
  const withTools = '3f8fad5b-d9cb-469f-a165-70867728950e'
  const file = chatSettings(withTools, { plugins: {}, skills: {} }, true, dir)!
  assert.equal(resumeSettingsArg(withTools, dir, '', 'posix'), ` --settings '${file}'`)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).remoteControlAtStartup, false)
  assert.equal(resumeSettingsArg('4f8fad5b-d9cb-469f-a165-70867728950e', dir, '', 'posix'), '')
})

test('no remote follows a handoff to the fresh chat, with or without tools; a normal chat hands off as before', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'))
  const old = '5f8fad5b-d9cb-469f-a165-70867728950e', fresh = '6f8fad5b-d9cb-469f-a165-70867728950e', fresh2 = '7f8fad5b-d9cb-469f-a165-70867728950e'
  chatSettings(old, undefined, true, dir)
  const p = { plugins: {}, skills: {} }
  const a = handoffSettings(old, fresh, p, dir)
  assert.equal(a.off, true)
  assert.equal(isNoRemote(fresh, dir), true)
  assert.equal(JSON.parse(fs.readFileSync(a.settings!, 'utf8')).remoteControlAtStartup, false)
  assert.deepEqual(handoffSettings(old, fresh2, undefined, dir), { settings: '{"remoteControlAtStartup":false}', off: true })
  const normal = '8f8fad5b-d9cb-469f-a165-70867728950e', next = '9f8fad5b-d9cb-469f-a165-70867728950e'
  const b = handoffSettings(normal, next, p, dir)
  assert.equal(b.off, false)
  assert.equal(isNoRemote(next, dir), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(b.settings!, 'utf8')), profileSettings(p))
  assert.deepEqual(handoffSettings(normal, 'a0f8fad5-d9cb-469f-a165-70867728950e', undefined, dir), { settings: undefined, off: false })
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
  assert.equal(commandProblem({ type: 'hub-chat-tools', sessionId: 'x', tools: { ...tools, assets: { 'a.md': true } } }), undefined)
  assert.ok(commandProblem({ type: 'hub-chat-tools', sessionId: 'x', tools: { ...tools, assets: 'all' } }))
})

const projInv: Installed[] = [
  ...inv,
  { kind: 'skill', name: 'apple-design', enabled: true, source: 'project', description: 'Apple motion for the web' },
  { kind: 'asset', name: 'apple', enabled: true, source: 'project', path: 'design-md/apple/DESIGN.md', description: 'Photography-first gallery look' },
  { kind: 'asset', name: 'raycast-DESIGN', enabled: true, source: 'project', path: 'docs/design/raycast-DESIGN.md', description: 'Raycast dark' },
]

test('pickPrompt: descriptions, project context, project skills and assets, the rules', () => {
  const s = pickPrompt('restyle the login page', projInv, 'Folder: Armasu\nCLAUDE.md:\nNext.js app')
  assert.match(s, /Folder: Armasu/)
  assert.match(s, /Next\.js app/)
  assert.match(s, /apple-design: Apple motion for the web/)
  assert.match(s, /- apple: Photography-first/)
  assert.match(s, /"assets"/)
  assert.match(s, /turn off/)
  assert.match(s, /impeccable/)
  assert.match(s, /claude-x-jev/)
})

test('pickPrompt: stays under the cap with a huge inventory and context', () => {
  const big: Installed[] = Array.from({ length: 400 }, (_, i) => ({ kind: i % 2 ? 'skill' : 'asset', name: `item-${i}`, enabled: true, path: `design-md/item-${i}/DESIGN.md`, description: 'x'.repeat(300) }))
  const s = pickPrompt('g'.repeat(5000), [...inv, ...big], 'c'.repeat(20000))
  assert.ok(s.length <= PROMPT_MAX, `${s.length}`)
  assert.match(s, /Answer with JSON only/)
})

test('pickPrompt: over the cap, asset descriptions go before plugin and skill ones', () => {
  const many: Installed[] = Array.from({ length: 80 }, (_, i) => ({ kind: 'asset', name: `brand-${i}`, enabled: true, path: `design-md/brand-${i}/DESIGN.md`, description: 'y'.repeat(150) }))
  const s = pickPrompt('restyle', [...projInv, ...many], 'c'.repeat(2000))
  assert.ok(s.length <= PROMPT_MAX)
  assert.match(s, /bland@bland: Voice agents/)
  assert.match(s, /apple-design: Apple motion for the web/)
  assert.match(s, /- brand-79$/m)
})

test('parsePick: assets turned off by name or path, missing assets means all on', () => {
  const p = parsePick('{"plugins":[],"skills":["apple-design"],"assets":["apple"]}', projInv)!
  assert.deepEqual(p.assets, { 'design-md/apple/DESIGN.md': false, 'docs/design/raycast-DESIGN.md': true })
  assert.equal(p.skills['apple-design'], false)
  assert.deepEqual(parsePick('{"plugins":[],"skills":[]}', projInv)!.assets, { 'design-md/apple/DESIGN.md': true, 'docs/design/raycast-DESIGN.md': true })
  assert.deepEqual(parsePick('{"plugins":[],"skills":[],"assets":["docs/design/raycast-DESIGN.md"]}', projInv)!.assets, { 'design-md/apple/DESIGN.md': true, 'docs/design/raycast-DESIGN.md': false })
})

test('defaultProfile: project skills and assets on; no assets key without assets', () => {
  const d = defaultProfile(projInv)
  assert.equal(d.skills['apple-design'], true)
  assert.deepEqual(d.assets, { 'design-md/apple/DESIGN.md': true, 'docs/design/raycast-DESIGN.md': true })
  assert.equal(defaultProfile(inv).assets, undefined)
})

test('cleanProfile: keeps an asset turned off, drops unknown ones', () => {
  const p = cleanProfile({ plugins: {}, skills: {}, assets: { 'design-md/apple/DESIGN.md': false, '../etc/passwd': true } }, projInv)
  assert.deepEqual(p.assets, { 'design-md/apple/DESIGN.md': false, 'docs/design/raycast-DESIGN.md': true })
})

test('toolsNote: tells the chat to read the design references on before UI work', () => {
  assert.equal(toolsNote({ plugins: {}, skills: {} }), TOOLS_NOTE)
  const n = toolsNote({ plugins: {}, skills: {}, assets: { 'design-md/apple/DESIGN.md': true, 'x.md': false } })
  assert.match(n, /read these design references first: design-md\/apple\/DESIGN\.md\.$/)
  assert.doesNotMatch(n, /x\.md/)
})

test('profileSettings: a project skill turned off goes through skillOverrides', () => {
  assert.deepEqual(profileSettings({ plugins: {}, skills: { 'apple-design': false }, assets: { 'a.md': true } }), { enabledPlugins: {}, skillOverrides: { 'apple-design': 'off' } })
})

test('resumeSettingsArg: a profile with assets resumes with the note', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'))
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
  saveProfile(id, { plugins: {}, skills: {}, assets: { "design-md/o'neil/DESIGN.md": true } }, dir)
  const arg = resumeSettingsArg(id, dir, '', 'posix')
  assert.match(arg, /--settings '.+' --append-system-prompt 'Switchboard started/)
  assert.match(arg, /o'\\''neil/)
})

test('pickProfile: a fallback is reported', async () => {
  const why: string[] = []
  await pickProfile('x', inv, async () => 'no json', 1000, w => why.push(w))
  await pickProfile('x', inv, async () => { throw new Error('boom') }, 1000, w => why.push(w))
  assert.equal(why.length, 2)
  assert.match(why[1], /boom/)
})

const libInv: Installed[] = [
  ...projInv,
  { kind: 'asset', name: 'cursor', enabled: true, source: 'library', path: '/h/lib/cursor/DESIGN.md', description: 'Warm cream editor' },
  { kind: 'asset', name: 'apple', enabled: true, source: 'library', path: '/h/lib/apple/DESIGN.md', description: 'Apple site' },
  ...['a', 'b', 'c'].map((n): Installed => ({ kind: 'asset', name: n, enabled: true, source: 'library', path: `/h/lib/${n}/DESIGN.md` })),
]

test('defaultProfile: library off, project assets on', () => {
  assert.deepEqual(defaultProfile(libInv).assets, {
    'design-md/apple/DESIGN.md': true, 'docs/design/raycast-DESIGN.md': true,
    '/h/lib/cursor/DESIGN.md': false, '/h/lib/apple/DESIGN.md': false, '/h/lib/a/DESIGN.md': false, '/h/lib/b/DESIGN.md': false, '/h/lib/c/DESIGN.md': false,
  })
})

test('parsePick: library names turn on, up to three, apart from project assets of the same name', () => {
  const p = parsePick('{"plugins":[],"skills":[],"assets":["apple"],"library":["cursor","a","b","c"]}', libInv)!
  assert.deepEqual(p.assets, {
    'design-md/apple/DESIGN.md': false, 'docs/design/raycast-DESIGN.md': true,
    '/h/lib/cursor/DESIGN.md': true, '/h/lib/apple/DESIGN.md': false, '/h/lib/a/DESIGN.md': true, '/h/lib/b/DESIGN.md': true, '/h/lib/c/DESIGN.md': false,
  })
  const none = parsePick('{"plugins":[],"skills":[]}', libInv)!
  assert.equal(Object.entries(none.assets!).filter(([k, on]) => on && k.startsWith('/h/lib')).length, 0)
})

test('pickPrompt: a design library section to turn on, only with a library', () => {
  const s = pickPrompt('restyle the login page', libInv)
  assert.match(s, /Design library:\n- cursor: Warm cream editor/)
  assert.match(s, /"library"/)
  assert.match(s, /up to 3/)
  assert.doesNotMatch(pickPrompt('x', projInv), /library/i)
})

test('pickPrompt: over the cap, library descriptions go first', () => {
  const many: Installed[] = Array.from({ length: 80 }, (_, i) => ({ kind: 'asset', name: `lib-${i}`, enabled: true, source: 'library', path: `/h/lib/lib-${i}/DESIGN.md`, description: 'z'.repeat(150) }))
  const s = pickPrompt('restyle', [...projInv, ...many], 'c'.repeat(2000))
  assert.ok(s.length <= PROMPT_MAX)
  assert.match(s, /- apple: Photography-first/)
  assert.match(s, /- lib-79$/m)
})

test('cleanProfile: keeps library keys turned on by hand', () => {
  const p = cleanProfile({ plugins: {}, skills: {}, assets: { '/h/lib/cursor/DESIGN.md': true, '/h/other.md': true } }, libInv)
  assert.equal(p.assets!['/h/lib/cursor/DESIGN.md'], true)
  assert.equal(p.assets!['/h/lib/apple/DESIGN.md'], false)
  assert.equal(p.assets!['/h/other.md'], undefined)
  assert.match(toolsNote(p), /\/h\/lib\/cursor\/DESIGN\.md/)
})

test('cleanName: trimmed, one line, capped at 40, junk is empty', () => {
  assert.equal(cleanName('  Kenneth  '), 'Kenneth')
  assert.equal(cleanName('Ken\n  Kang'), 'Ken Kang')
  assert.equal(cleanName('x'.repeat(60)), 'x'.repeat(40))
  assert.equal(cleanName('   '), '')
  assert.equal(cleanName(`O'Brien "K" \`id\` $(x); \u2019a\u0007`), 'OBrien K id (x) a')
  assert.equal(cleanName(42), '')
})

test('nameNote: names the user when set, nothing when empty', () => {
  assert.equal(nameNote(''), undefined)
  assert.equal(nameNote('  '), undefined)
  const n = nameNote(' Kenneth ')!
  assert.match(n, /^Address the user as Kenneth\./)
  assert.match(n, /chat replies only, never files, code or commits/)
  assert.doesNotMatch(n, /Jarvis|Iron Man|sir|'/i)
})

test('resumeSettingsArg: an extra note rides along, with or without a profile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'))
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
  assert.equal(resumeSettingsArg(id, dir, "Call me O'Neil.", 'posix'), ` --append-system-prompt 'Call me O'\\''Neil.'`)
  assert.equal(resumeSettingsArg(id, dir, "Call me O'Neil.", 'powershell'), ` --append-system-prompt 'Call me O''Neil.'`)
  const file = saveProfile(id, { plugins: {}, skills: {} }, dir)
  assert.equal(resumeSettingsArg(id, dir, 'Hi.', 'posix'), ` --settings '${file}' --append-system-prompt 'Hi.'`)
  assert.equal(resumeSettingsArg(id, dir, '', 'posix'), ` --settings '${file}'`)
})

test('routes: the name setting takes a string', async () => {
  const { commandProblem } = await import('../src/hub/routes')
  assert.equal(commandProblem({ type: 'hub-switchboard', key: 'name', value: 'Kenneth' }), undefined)
  assert.ok(commandProblem({ type: 'hub-switchboard', key: 'nickname', value: 'Kenneth' }))
})

// PowerShell: ; # $ ` " are literal inside '...', where '' is one quote; true when the line is that one token.
const psToken = (q: string) => /^'(?:[^'\u2018-\u201B]|''|[\u2018-\u201B]{2})*'$/.test(q)

test('resume quoting: hostile notes stay one argument in POSIX sh and PowerShell', async () => {
  const { execFileSync } = await import('child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'))
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
  for (const n of [`x'; calc.exe; #`, `"q"`, '`id`', '$(whoami)', 'a;b', '# c', `O\u2019Neil`]) {
    const arg = resumeSettingsArg(id, dir, n, 'posix')
    const out = execFileSync('sh', ['-c', `printf '[%s]\\n'${arg}`]).toString()
    assert.equal(out, `[--append-system-prompt]\n[${n}]\n`, n)
    const ps = resumeSettingsArg(id, dir, n, 'powershell').replace(' --append-system-prompt ', '')
    assert.ok(psToken(ps), `${n} -> ${ps}`)
  }
})
