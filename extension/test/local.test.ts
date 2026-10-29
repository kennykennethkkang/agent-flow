/**
 * Unit tests for what the Hub reads off this machine: the plan, dev servers,
 * git and installed items. Parsers only; no process runs.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { parseGitStatus, parseLsof, parseNetstat, parsePlan, decodeProjectDir, installed, pluginMcp, projectInventory, projectContext } from '../src/hub/local'

describe('local readers', () => {
  it('reads plan tasks and their boxes', () => {
    const view = parsePlan('p.md', ['# P', '### Task 1: Settings', '- [x] a', '- [x] b', '### Task 2: Memory', '- [x] a', '- [ ] b'].join('\n'))
    assert.deepEqual(view.tasks, [{ title: '1 Settings', done: 2, total: 2 }, { title: '2 Memory', done: 1, total: 2 }])
  })

  it('keeps the last five plan decisions, from a table or a list, without markdown', () => {
    const rows = ['## Decisions', '', '| Question | Pick | Source |', '|---|---|---|', ...[1, 2, 3, 4, 5].map(n => `| Q${n} | **P${n}** | x |`), '- **Gate** off by default', '- [ ] not a decision', '## Tasks', '- other']
    assert.deepEqual(parsePlan('p.md', rows.join('\n')).decisions, ['Q2: P2', 'Q3: P3', 'Q4: P4', 'Q5: P5', 'Gate off by default'])
    assert.equal(parsePlan('p.md', '### Task 1: A\n- [ ] a').decisions, undefined)
  })

  it('keeps dev servers from lsof, one row per port', () => {
    const out = ['p29313', 'cnode', 'n*:3000', 'p24970', 'cDiscord', 'n127.0.0.1:6463', 'p2635', 'cPython', 'n127.0.0.1:4211', 'n[::1]:4211'].join('\n')
    assert.deepEqual(parseLsof(out), [{ pid: 29313, command: 'node', port: 3000 }, { pid: 2635, command: 'Python', port: 4211 }])
  })

  it('keeps dev servers from netstat on Windows', () => {
    const netstat = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4120',
      '  TCP    127.0.0.1:6463         0.0.0.0:0              LISTENING       900',
      '  TCP    [::]:3000              [::]:0                 LISTENING       4120',
    ].join('\r\n')
    const tasklist = ['"Image Name","PID","Session Name","Session#","Mem Usage"', '"node.exe","4120","Console","1","80,000 K"', '"Discord.exe","900","Console","1","90,000 K"'].join('\r\n')
    assert.deepEqual(parseNetstat(netstat, tasklist), [{ pid: 4120, command: 'node', port: 3000 }])
  })

  it('reads git porcelain v2', () => {
    const out = ['# branch.oid abc', '# branch.head Social-media-dev', '# branch.ab +2 -1', '1 .M N... 100644 100644 100644 a b app/page.tsx', '1 M. N... 100644 100644 100644 a b app/x.ts', '? notes.md'].join('\n')
    assert.deepEqual(parseGitStatus(out), { branch: 'Social-media-dev', ahead: 2, behind: 1, changed: 2, staged: 1, untracked: 1 })
  })


  it('turns a Claude Code project folder back into a name', () => {
    assert.equal(decodeProjectDir('-Users-k-Documents-GitHub-Armasu'), 'Armasu')
    assert.equal(decodeProjectDir('C--Users-k-Documents-CSEN122'), 'CSEN122')
  })
})

describe('installed', () => {
  it('lists plugins with their skills, real skills, archived skills, roles and presets', async () => {
    const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-installed-'))
    const put = (rel: string, text = '') => { fs.mkdirSync(path.dirname(path.join(claude, rel)), { recursive: true }); fs.writeFileSync(path.join(claude, rel), text) }
    const plug = path.join(claude, 'plugins', 'cache', 'p')
    put('settings.json', JSON.stringify({ enabledPlugins: { 'p@m': true, 'off@m': false, 'meter@kenneth-mods': true } }))
    put('plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: {
      'p@m': [{ scope: 'project', installPath: '/nowhere' }, { scope: 'user', installPath: plug }],
      'gh@m': [{ scope: 'user', installPath: path.join(claude, 'nowhere') }],
    } }))
    put('plugins/cache/p/.claude-plugin/plugin.json', JSON.stringify({ name: 'p', skills: ['./extra', './one'] }))
    put('plugins/cache/p/skills/alpha/SKILL.md', '---\nname: alpha-named # comment\ndescription: x\n---\n')
    put('plugins/cache/p/skills/beta/SKILL.md', 'no frontmatter\nname: body-line')
    put('plugins/cache/p/extra/delta/SKILL.md', '---\nname: delta\n---')
    put('plugins/cache/p/one/SKILL.md', '---\nname: solo\n---')
    put('plugins/cache/p/v2/skills/gamma/SKILL.md', '---\nname: gamma\n---')
    put('elsewhere/linked/SKILL.md', '---\nname: linked\n---')
    fs.symlinkSync(path.join(claude, 'elsewhere', 'linked'), path.join(plug, 'skills', 'linked'))
    put('skills/phone/SKILL.md', '---\nname: phone\n---')
    put('skills/synced/notes.txt')
    put('skills-archive/drei/SKILL.md')
    put('agents/qa.md', '---\nname: qa\nmodel: opus\n---\n'); put('agents/engineer.md'); put('agents/readme.txt')
    put('jev-presets/route.json', '{}')
    const out = await installed(claude)
    const by = (kind: string) => out.filter(i => i.kind === kind).map(i => [i.name, i.enabled]).sort()
    assert.deepEqual(by('plugin'), [['gh@m', false], ['off@m', false], ['p@m', true]])
    assert.deepEqual(out.find(i => i.name === 'p@m')?.skills?.sort(), ['alpha-named', 'beta', 'delta', 'linked', 'solo'])
    assert.deepEqual(by('mod'), [['meter@kenneth-mods', true]])
    assert.deepEqual(by('skill'), [['drei', false], ['phone', true]])
    assert.deepEqual(by('role'), [['engineer', true], ['qa', true]])
    assert.deepEqual(out.filter(i => i.kind === 'role').map(i => [i.name, i.model]).sort(), [['engineer', undefined], ['qa', 'opus']])
    assert.deepEqual(by('preset'), [['route', true]])
    fs.rmSync(claude, { recursive: true, force: true })
  })

  const sandbox = (plugins: Record<string, Record<string, string>>, enabled: Record<string, boolean>) => {
    const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-plugins-'))
    const put = (rel: string, text = '') => { fs.mkdirSync(path.dirname(path.join(claude, rel)), { recursive: true }); fs.writeFileSync(path.join(claude, rel), text) }
    put('settings.json', JSON.stringify({ enabledPlugins: enabled }))
    put('plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: Object.fromEntries(Object.keys(plugins).map(id => [id, [{ scope: 'user', installPath: path.join(claude, 'cache', id) }]])) }))
    for (const [id, files] of Object.entries(plugins)) for (const [rel, text] of Object.entries(files)) put(path.join('cache', id, rel), text)
    return claude
  }

  it('counts plugin commands with skills: commands/*.md, or what plugin.json commands names instead', async () => {
    const claude = sandbox({
      'code-review@o': { '.claude-plugin/plugin.json': '{"name":"code-review"}', 'commands/code-review.md': '# review' },
      'arr@o': { '.claude-plugin/plugin.json': JSON.stringify({ commands: ['./cmds/a.md', './more'] }), 'cmds/a.md': '', 'more/b.md': '', 'more/b.toml': '', 'commands/replaced.md': '', 'skills/a/SKILL.md': '' },
      'map@o': { '.claude-plugin/plugin.json': JSON.stringify({ commands: { hello: { source: './x.md' } } }), 'x.md': '' },
      'one@o': { '.claude-plugin/plugin.json': JSON.stringify({ commands: './only.md' }), 'only.md': '' },
    }, { 'code-review@o': true, 'arr@o': true, 'map@o': true, 'one@o': true })
    const skills = Object.fromEntries((await installed(claude)).map(i => [i.name.split('@')[0], i.skills?.sort()]))
    assert.deepEqual(skills, { 'code-review': ['code-review'], arr: ['a', 'b'], map: ['hello'], one: ['only'] })
    fs.rmSync(claude, { recursive: true, force: true })
  })

  it('carries descriptions: plugin.json for a plugin, SKILL.md frontmatter for a user skill, cut short', async () => {
    const claude = sandbox({ 'd@o': { '.claude-plugin/plugin.json': JSON.stringify({ description: 'Voice agents' }) } }, { 'd@o': true })
    fs.mkdirSync(path.join(claude, 'skills', 'phone'), { recursive: true })
    fs.writeFileSync(path.join(claude, 'skills', 'phone', 'SKILL.md'), `---\nname: phone\ndescription: "Call the owner ${'x'.repeat(300)}"\n---\n`)
    const out = await installed(claude)
    assert.equal(out.find(i => i.name === 'd@o')?.description, 'Voice agents')
    const d = out.find(i => i.name === 'phone')?.description ?? ''
    assert.ok(d.startsWith('Call the owner') && d.length <= 160)
    fs.rmSync(claude, { recursive: true, force: true })
  })

  it('reads MCP servers from enabled plugins: .mcp.json either shape and plugin.json mcpServers', async () => {
    const claude = sandbox({
      'github@o': { '.mcp.json': JSON.stringify({ github: { type: 'http' } }) },
      'context7@o': { '.mcp.json': JSON.stringify({ mcpServers: { context7: {} } }) },
      'bland@o': { '.claude-plugin/plugin.json': JSON.stringify({ mcpServers: { bland: {} } }) },
      'file@o': { '.claude-plugin/plugin.json': JSON.stringify({ mcpServers: './servers.json' }), 'servers.json': JSON.stringify({ mcpServers: { linked: {} } }) },
      'mix@o': { '.claude-plugin/plugin.json': JSON.stringify({ mcpServers: ['./a.json', { inline: {} }] }), 'a.json': JSON.stringify({ fromFile: {} }) },
      'off@o': { '.mcp.json': JSON.stringify({ nope: {} }) },
    }, { 'github@o': true, 'context7@o': true, 'bland@o': true, 'file@o': true, 'mix@o': true, 'off@o': false })
    const got = (await pluginMcp(claude)).map(c => [c.name, c.detail, c.kind]).sort()
    assert.deepEqual(got, [['bland', 'bland', 'mcp'], ['context7', 'context7', 'mcp'], ['fromFile', 'mix', 'mcp'], ['github', 'github', 'mcp'], ['inline', 'mix', 'mcp'], ['linked', 'file', 'mcp']])
    fs.rmSync(claude, { recursive: true, force: true })
  })
})

describe('project skills, assets and context', () => {
  const tree = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'))
    const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }
    put('.agents/skills/animate/SKILL.md', '---\nname: animate\ndescription: Build an animation\n---\n')
    put('.agents/skills/only-agents/SKILL.md', '---\ndescription: Lives in .agents only\n---\n')
    put('.agents/skills/no-skill-file/README.md', 'x')
    put('.agents/skills/folded/SKILL.md', '---\nname: folded\ndescription: >-\n  Turns a page\n  into HTML\nlicense: MIT\n---\n')
    fs.mkdirSync(path.join(root, '.claude/skills'), { recursive: true })
    fs.symlinkSync('../../.agents/skills/animate', path.join(root, '.claude/skills/animate'))
    put('design-md/apple/DESIGN.md', '---\nname: apple\ndescription: Photography-first gallery\n---\n# Apple\n')
    put('design-md/stripe/README.md', '<!-- c -->\n# Stripe Look\n')
    put('design-md/_UPSTREAM-README.md', '# not a folder')
    put('docs/design/raycast-DESIGN.md', '<!-- note -->\n# Raycast dark\n')
    put('DESIGN.md', '# Root look\n')
    put('CLAUDE.md', Array.from({ length: 60 }, (_, i) => `rule ${i}`).join('\n'))
    put('package.json', JSON.stringify({ dependencies: { next: '1', react: '1' }, devDependencies: { tailwindcss: '1' } }))
    return root
  }

  it('lists project skills through symlinks, deduped, and design assets', async () => {
    const root = tree()
    const got = await projectInventory(root)
    const skills = got.filter(i => i.kind === 'skill').map(i => [i.name, i.source, i.description])
    assert.deepEqual(skills.sort(), [['animate', 'project', 'Build an animation'], ['folded', 'project', 'Turns a page into HTML'], ['only-agents', 'project', 'Lives in .agents only']])
    const assets = got.filter(i => i.kind === 'asset').map(i => [i.name, i.path, i.description])
    assert.deepEqual(assets.sort(), [
      ['DESIGN', 'DESIGN.md', 'Root look'],
      ['apple', 'design-md/apple/DESIGN.md', 'Photography-first gallery'],
      ['raycast-DESIGN', 'docs/design/raycast-DESIGN.md', 'Raycast dark'],
      ['stripe', 'design-md/stripe/README.md', 'Stripe Look'],
    ])
    assert.deepEqual(await projectInventory(path.join(root, 'missing')), [])
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('project context: folder, the first 40 lines of CLAUDE.md, dependency names', async () => {
    const root = tree()
    const c = await projectContext(root)
    assert.match(c, new RegExp(`Folder: ${path.basename(root)}`))
    assert.match(c, /rule 39/)
    assert.doesNotMatch(c, /rule 40/)
    assert.match(c, /next, react, tailwindcss/)
    fs.rmSync(root, { recursive: true, force: true })
  })
})
