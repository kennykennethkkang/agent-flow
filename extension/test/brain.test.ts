/**
 * Unit tests for the brain: the board, its four rules and the brief a new chat gets.
 *
 * The invariant: a chat learns only its own project, and a brief carries no key.
 */

import { describe, it } from 'node:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import assert from 'node:assert/strict'
import { board, brief, quickAskArgs, suggest, withBrief } from '../src/hub/brain'
import { emptyHub } from '../src/hub/hub-service'
import type { HubState, SessionLive, StarredChat } from '../src/hub/types'

const NOW = 10_000_000
const chat = (sessionId: string, cwd: string, extra: Partial<SessionLive> = {}): SessionLive =>
  ({ sessionId, cwd, limits: [], at: NOW - 1000, ...extra })

const state = (live: SessionLive[], extra: Partial<HubState> = {}): HubState => ({
  ...emptyHub(),
  live,
  projects: [{ name: 'Armasu', path: '/w/Armasu', kind: 'repo', isOpen: true }, { name: 'agent-flow', path: '/w/agent-flow', kind: 'repo', isOpen: false }],
  ...extra,
})

describe('brain board', () => {
  it('groups live chats by project, a subfolder under its project', () => {
    const b = board(state([chat('a', '/w/Armasu'), chat('b', '/w/Armasu/app', { prompt: 'fix the bag' }), chat('c', '/w/agent-flow')]))
    assert.deepEqual(b.map(p => [p.project, p.chats.length]), [['Armasu', 2], ['agent-flow', 1]])
    assert.equal(b[0].chats.find(c => c.sessionId === 'b')?.prompt, 'fix the bag')
  })

  it('names a subfolder of a git repo by the repo, even when the subfolder is listed', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-brain-'))
    try {
      const repo = path.join(tmp, 'agent-flow'), sub = path.join(repo, 'extension')
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
      fs.mkdirSync(sub)
      const b = board(state([chat('a', sub), chat('b', repo)], { projects: [{ name: 'extension', path: sub, kind: 'project', isOpen: false }] }))
      assert.deepEqual(b.map(p => [p.project, p.chats.length]), [['agent-flow', 2]])
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })

  it('names a folder outside every project by its last part', () => {
    assert.equal(board(state([chat('a', '/tmp/scratch')]))[0].project, 'scratch')
  })
})

describe('brain rules', () => {
  it('flags two chats on one file within the hour, not after it', () => {
    const near = suggest(state([chat('a', '/w/Armasu', { file: '/w/Armasu/x.ts', fileAt: NOW - 60_000 }), chat('b', '/w/Armasu', { file: '/w/Armasu/x.ts', fileAt: NOW - 120_000 })]), [], NOW)
    assert.deepEqual(near.filter(s => s.kind === 'clash').map(s => s.sessions), [['a', 'b']])
    const old = suggest(state([chat('a', '/w/Armasu', { file: '/w/Armasu/x.ts', fileAt: NOW - 2 * 3600_000 }), chat('b', '/w/Armasu', { file: '/w/Armasu/x.ts', fileAt: NOW })]), [], NOW)
    assert.equal(old.filter(s => s.kind === 'clash').length, 0)
  })

  it('flags a chat past 85% of its compaction point', () => {
    const s = suggest(state([chat('a', '/w/Armasu', { tokens: 86, compactAt: 100 }), chat('b', '/w/Armasu', { tokens: 80, compactAt: 100 })]), [], NOW)
    assert.deepEqual(s.filter(x => x.kind === 'full').map(x => x.sessions), [['a']])
  })

  it('offers the next open task only when no chat names it', () => {
    const plan = { name: 'p.md', tasks: [{ title: '21 The brain', done: 4, total: 4 }, { title: '22 Ship it', done: 0, total: 3 }] }
    const free = suggest(state([chat('a', '/w/Armasu', { prompt: 'look at the logo' })], { plan }), [], NOW)
    assert.equal(free.find(x => x.kind === 'task')?.task, '22 Ship it')
    const taken = suggest(state([chat('a', '/w/Armasu', { prompt: 'carry on with Task 22' })], { plan }), [], NOW)
    assert.equal(taken.filter(x => x.kind === 'task').length, 0)
  })

  it('flags a dev server that stopped', () => {
    const s = suggest(state([]), [{ pid: 1, command: 'next', port: 3000, folder: '/w/Armasu' }], NOW)
    assert.equal(s.find(x => x.kind === 'server')?.folder, '/w/Armasu')
  })
})

describe('brain brief', () => {
  const plan = { name: 'p.md', tasks: [{ title: '22 Ship it', done: 0, total: 3 }] }
  const live = [
    chat('me', '/w/Armasu'),
    chat('other', '/w/Armasu', { label: 'Shop', prompt: 'key sk-abcdefghijklmnopqrstuv in the shop', file: '/w/Armasu/app/shop.ts', fileAt: NOW - 1000 }),
    chat('far', '/w/agent-flow', { prompt: 'secret agent-flow work', file: '/w/agent-flow/x.ts' }),
  ]
  const servers = [{ pid: 2, command: 'next dev', port: 3000, folder: '/w/Armasu' }]

  it('lists the other chats, their files, the next task and the dev site', () => {
    const text = brief(state(live, { plan, servers }), '/w/Armasu', 'me', NOW)
    assert.match(text, /Shop/)
    assert.match(text, /app\/shop\.ts/)
    assert.match(text, /22 Ship it/)
    assert.match(text, /localhost:3000/)
  })

  it('carries the recent plan decisions for the open project', () => {
    const text = brief(state(live, { plan: { ...plan, decisions: ['Gate: off by default'] }, servers }), '/w/Armasu', 'me', NOW)
    assert.match(text, /Recent decisions: Gate: off by default/)
    assert.doesNotMatch(brief(state(live, { plan: { ...plan, decisions: ['Gate: off by default'] }, servers }), '/w/agent-flow', 'far', NOW), /Recent decisions/)
  })

  it('names the starred chats of the same project, with their last prompt or note', () => {
    const star = (sessionId: string, name: string, cwd: string, digest: Partial<StarredChat['digest']>) => ({ sessionId, ai: 'claude' as const, name, cwd, starredAt: 1, live: false, digest: { resume: '', ...digest } })
    const starred = [star('s1', 'agentFlow', '/w/Armasu', { lastPrompt: 'add codex' }), star('s2', 'Far', '/w/agent-flow', { note: 'elsewhere' }), star('me', 'Self', '/w/Armasu', { note: 'x' })]
    const text = brief(state([], { starred }), '/w/Armasu', 'me', NOW)
    assert.match(text, /Starred: agentFlow: "add codex"/)
    assert.doesNotMatch(text, /Far|Self/)
  })

  it('tells a chat nothing about another project, and removes keys', () => {
    const text = brief(state(live, { plan, servers }), '/w/Armasu', 'me', NOW)
    assert.doesNotMatch(text, /agent-flow/)
    assert.doesNotMatch(text, /sk-abc/)
    assert.match(text, /\[removed\]/)
  })

  it('lists the project\'s open to-do items with their ids, never another project\'s', () => {
    const todos = { '/w/Armasu': { todo: [{ id: 'ab12cd34', text: 'Add CSV export', at: 1 }] }, '/w/agent-flow': { todo: [{ id: 'ff00ff00', text: 'Far item', at: 1 }] } }
    const text = brief(state([chat('me', '/w/Armasu')], { todos }), '/w/Armasu/app', 'me', NOW)
    assert.match(text, /Open to-do[^\n]*todo_done[^\n]*\n- ab12cd34: Add CSV export/)
    assert.doesNotMatch(text, /ff00ff00/)
  })

  it('stays under 1,200 characters', () => {
    const many = Array.from({ length: 40 }, (_, i) => chat(`s${i}`, '/w/Armasu', { prompt: 'x'.repeat(200), file: `/w/Armasu/f${i}.ts`, fileAt: NOW }))
    assert.ok(brief(state(many, { plan, servers }), '/w/Armasu', 'me', NOW).length <= 1200)
  })

  it('is empty for a chat alone with nothing to say', () => {
    assert.equal(brief(state([chat('me', '/w/Armasu')]), '/w/Armasu', 'me', NOW), '')
  })
})

describe('quickAskArgs', () => {
  it('saves no session and runs no hooks', () => {
    const args = quickAskArgs('hi')
    assert.ok(args.includes('--no-session-persistence'))
    assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { disableAllHooks: true })
    assert.equal(args.at(-1), 'hi')
  })
})

describe('withBrief', () => {
  it('puts the brief in front of a Codex first message only while Brief is on', () => {
    const s: HubState = { ...emptyHub(), projects: [{ name: 'Armasu', path: '/u/Armasu', kind: 'repo', isOpen: true }], servers: [{ pid: 1, command: 'node', port: 4211, folder: '/u/Armasu' }] }
    assert.match(withBrief(s, '/u/Armasu', 'fix it'), /^Switchboard brief for Armasu[\s\S]*\n\nfix it$/)
    const off = { ...s, controls: { ...s.controls, switchboard: { ...s.controls.switchboard, brief: false } } }
    assert.equal(withBrief(off, '/u/Armasu', 'fix it'), 'fix it')
    assert.equal(withBrief(off, '/u/Armasu', undefined), '')
  })
})
