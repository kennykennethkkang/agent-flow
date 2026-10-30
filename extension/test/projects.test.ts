/**
 * Projects and new chats: the project list, what a clone box accepts, and the
 * command a new chat runs.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { chainBase, chainVersion, chatLabel, cloneTarget, codexNote, freshPrompt, handoffFile, labelNote, mergeProjects, newChatCommand, nextChainName, projectName, repoTop, scriptBody, scriptLine, stillRunning } from '../src/hub/projects'

describe('projectName', () => {
  it('names a folder by the git repo holding it, else its last part', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-repo-'))
    try {
      fs.mkdirSync(path.join(tmp, 'agent-flow', '.git'), { recursive: true })
      fs.mkdirSync(path.join(tmp, 'agent-flow', 'extension', 'src'), { recursive: true })
      // A worktree or submodule has a .git file.
      fs.mkdirSync(path.join(tmp, 'wt', 'app'), { recursive: true })
      fs.writeFileSync(path.join(tmp, 'wt', '.git'), 'gitdir: /x')
      fs.mkdirSync(path.join(tmp, 'plain'))
      assert.equal(projectName(path.join(tmp, 'agent-flow', 'extension')), 'agent-flow')
      assert.equal(projectName(path.join(tmp, 'agent-flow', 'extension', 'src')), 'agent-flow')
      assert.equal(repoTop(path.join(tmp, 'agent-flow', 'extension')), path.join(tmp, 'agent-flow'))
      assert.equal(projectName(path.join(tmp, 'wt', 'app')), 'wt')
      assert.equal(projectName(path.join(tmp, 'plain')), 'plain')
      assert.equal(repoTop(path.join(tmp, 'plain')), undefined)
      assert.equal(projectName('/gone/folder/'), 'folder')
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
})

describe('projects', () => {
  it('lists repos and Claude Code projects once each, the open one marked', () => {
    const list = mergeProjects(['/u/GitHub/Armasu', '/u/GitHub/claude-mods'], ['/u/GitHub/Armasu', '/u/Documents/CSEN122'], '/u/GitHub/Armasu')
    assert.deepEqual(list.map(p => [p.name, p.kind, p.isOpen]), [
      ['Armasu', 'repo', true],
      ['claude-mods', 'repo', false],
      ['CSEN122', 'project', false],
    ])
  })

  it('accepts GitHub repos as owner/repo or a URL and refuses anything else', () => {
    assert.deepEqual(cloneTarget('kennykennethkkang/Armasu'), { url: 'https://github.com/kennykennethkkang/Armasu.git', name: 'Armasu' })
    assert.deepEqual(cloneTarget('https://github.com/patoles/agent-flow'), { url: 'https://github.com/patoles/agent-flow.git', name: 'agent-flow' })
    assert.deepEqual(cloneTarget('git@github.com:patoles/agent-flow.git'), { url: 'git@github.com:patoles/agent-flow.git', name: 'agent-flow' })
    assert.equal(cloneTarget('https://evil.example/x/y'), undefined)
    assert.equal(cloneTarget('a/b; rm -rf ~'), undefined)
    assert.equal(cloneTarget('../../etc'), undefined)
  })

  it('types a short line that runs the command from a file, since a typed line past 1024 bytes is cut before the shell is ready', () => {
    assert.equal(scriptLine("/var/folders/x/T/switchboard-1.sh", 'posix'), ". '/var/folders/x/T/switchboard-1.sh'")
    assert.equal(scriptLine("C:\\Temp\\it's.ps1", 'powershell'), "iex (Get-Content -Raw 'C:\\Temp\\it''s.ps1')")
    assert.equal(scriptBody('/t/a b.sh', 'claude', 'posix'), "rm -f -- '/t/a b.sh'\nclaude\n")
    assert.equal(scriptBody('C:\\t\\a.ps1', 'claude', 'powershell'), "Remove-Item -LiteralPath 'C:\\t\\a.ps1' -ErrorAction SilentlyContinue\nclaude\n")
  })
  it('builds the new chat command, quoting the first message for the shell', () => {
    assert.equal(newChatCommand({}, 'posix'), 'claude')
    // --remote-control takes an optional name, so the name always comes first or it would swallow the message.
    assert.equal(newChatCommand({ text: "Fix the closet's filter", remote: 'Armasu' }, 'posix'), "claude --remote-control 'Armasu' 'Fix the closet'\\''s filter'")
    assert.equal(newChatCommand({ text: "it's\nfine", remote: undefined }, 'powershell'), "claude 'it''s fine'")
    assert.equal(newChatCommand({ branch: 'claude/fix-filter' }, 'posix'), "git switch -c 'claude/fix-filter' && claude")
    assert.equal(newChatCommand({ branch: 'claude/fix-filter' }, 'powershell'), "git switch -c 'claude/fix-filter'; if ($?) { claude }")
  })

  it('starts a profiled chat under its own session id, settings file and tools note', () => {
    assert.equal(newChatCommand({ text: 'go', name: 'Go', sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e', settings: '/h/p.json', system: "Ask, don't guess." }, 'posix'),
      "claude --name 'Go' --session-id 0f8fad5b-d9cb-469f-a165-70867728950e --settings '/h/p.json' --append-system-prompt 'Ask, don'\\''t guess.' 'go'")
    assert.throws(() => newChatCommand({ sessionId: 'x; rm -rf ~' }, 'posix'))
  })

  it('reads a first message from its file, so a long one never overflows the terminal line', () => {
    assert.equal(newChatCommand({ text: 'ignored', textFile: "/t/it's.txt" }, 'posix'), `claude "$(cat '/t/it'\\''s.txt')"`)
    assert.equal(newChatCommand({ textFile: '/t/m.txt' }, 'powershell'), "claude (Get-Content -Raw '/t/m.txt')")
  })

  it('doubles every single quote PowerShell reads as one, curly ones too', () => {
    assert.equal(newChatCommand({ text: 'it\u2019s \u2018x\u2019 \u201ay\u201b' }, 'powershell'), "claude 'it\u2019\u2019s \u2018\u2018x\u2019\u2019 \u201a\u201ay\u201b\u201b'")
  })

  it('quotes any branch git may take, and refuses only one read as a flag, empty, or with spaces', () => {
    assert.equal(newChatCommand({ branch: 'fix#12' }, 'posix'), "git switch -c 'fix#12' && claude")
    assert.equal(newChatCommand({ branch: "a;b'c" }, 'posix'), "git switch -c 'a;b'\\''c' && claude")
    for (const bad of ['-x', 'a b', '', 'a\nb']) assert.throws(() => newChatCommand({ branch: bad }, 'posix'), /branch/)
  })
})

describe('chain names', () => {
  it('labels a chat from its plan, else its task, else continued', () => {
    assert.equal(chatLabel('Armasu', '/u/Armasu/docs/superpowers/plans/2026-10-01-p4-accessories-fit-and-more.md'), 'Armasu · P4 accessories fit')
    assert.equal(chatLabel('Armasu', undefined, 'fix the closet regen button'), 'Armasu · Fix the closet')
    assert.equal(chatLabel('Armasu'), 'Armasu · continued')
    assert.ok(chatLabel('x'.repeat(80)).length <= 60)
  })
  it('names the next chat after its origin with a version: origin is v1, then v2, v3', () => {
    assert.equal(nextChainName('Fix login redirect', 'Armasu'), 'Fix login redirect v2')
    assert.equal(nextChainName('Fix login redirect v2', 'Armasu'), 'Fix login redirect v3')
    assert.equal(nextChainName('Fix login redirect v9', 'Armasu'), 'Fix login redirect v10')
    // A legacy `Base · N` chain carries on in the new scheme.
    assert.equal(nextChainName('Armasu · P4 accessories fit · 2', 'Armasu'), 'Armasu · P4 accessories fit v3')
    assert.equal(nextChainName(undefined, 'Armasu', undefined, 'regen button'), 'Armasu · Regen button v2')
    assert.equal(nextChainName(undefined, 'Armasu'), 'Armasu · continued v2')
  })
  it('caps a long name without cutting off its version', () => {
    const next = nextChainName(`${'x'.repeat(80)} v12`, 'Armasu')
    assert.ok(next.length <= 60)
    assert.match(next, /^x+ v13$/)
  })
  it('finds the origin and version of a chain name', () => {
    assert.equal(chainBase('Fix login redirect v3'), 'Fix login redirect')
    assert.equal(chainBase('Armasu · P4 accessories fit · 3'), 'Armasu · P4 accessories fit')
    assert.equal(chainBase('Fix closet 2'), undefined)
    assert.equal(chainBase('Fix login redirect'), undefined)
    assert.equal(chainBase(undefined), undefined)
    assert.equal(chainVersion('Fix login redirect v3'), 3)
    assert.equal(chainVersion('Armasu · continued · 2'), 2)
    assert.equal(chainVersion('Fix login redirect'), 1)
    assert.equal(chainVersion(undefined), 1)
  })
  it('passes the name to claude', () => {
    assert.equal(newChatCommand({ name: 'Armasu · continued · 2', text: 'go' }, 'posix'), "claude --name 'Armasu · continued · 2' 'go'")
  })
})

describe('handoff notes', () => {
  const fields = { n: 2, base: 'Fix closet', from: 'Fix closet', id8: 'abcd1234', to: 'Fix closet v2', branch: 'main', plan: 'none' }
  it('puts a header on a note once', () => {
    const once = labelNote('# Handoff: Armasu\nbody', fields)
    assert.equal(once, '# Handoff v2 · Fix closet\nFrom: Fix closet (abcd1234)\nTo:   Fix closet v2\nBranch: main · Plan: none\n\n# Handoff: Armasu\nbody')
    assert.equal(labelNote(once, { ...fields, n: 3 }), once)
    // A note labeled by an older Switchboard keeps its header too.
    const legacy = '# Handoff 1 · Armasu · continued\nbody'
    assert.equal(labelNote(legacy, fields), legacy)
  })
  it('tells the fresh chat to recreate every open task before other work', () => {
    const text = freshPrompt('/u/.claude/handoffs/A/n-abcdef12.md')
    assert.match(text, /^Continue from \/u\/\.claude\/handoffs\/A\/n-abcdef12\.md: read it first/)
    assert.match(text, /recreate every open task .* with the task tools before any other work/)
  })
  it('lists subagents still running at the cap with where their output is', () => {
    assert.equal(stillRunning('note\n', undefined), 'note\n')
    const out = stillRunning('note\n', ['engineer e1'])
    assert.match(out, /## Still running at the 30 minute wait cap/)
    assert.match(out, /- engineer e1: output in subagents\/agent-e1\.jsonl next to the old transcript/)
  })
  it('names a note by date, project, label and id', () => {
    assert.equal(handoffFile('Armasu', 'P4 accessories fit', 'abcd1234-ffff', Date.UTC(2026, 9, 27, 9, 5)), '2026-10-27-0905-armasu-p4-accessories-fit-abcd1234.md')
  })
  it('writes a Codex handoff note', () => {
    const note = codexNote({ project: 'Armasu', cwd: '/u/Armasu', branch: 'main', plan: '/u/Armasu/p.md', prompt: 'x'.repeat(600) }, Date.UTC(2026, 9, 27, 9, 5))
    assert.match(note, /^# Handoff: Armasu, 2026-10-27 09:05 UTC\n/)
    assert.match(note, /Folder: \/u\/Armasu\nBranch: main\nPlan: \/u\/Armasu\/p\.md\n/)
    assert.ok(note.includes('x'.repeat(500)) && !note.includes('x'.repeat(501)))
  })
})
