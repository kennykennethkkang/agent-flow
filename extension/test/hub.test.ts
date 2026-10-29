/**
 * Unit tests for the Hub's state and its two routes.
 *
 * The invariant: nothing reaches the Hub or a chat's inbox without the
 * window's token, and an inbox hands each item over exactly once.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { HubService } from '../src/hub/hub-service'
import { commandProblem, handleHub as route, type HubReply } from '../src/hub/routes'
import { board, suggest } from '../src/hub/brain'

// Only /hub/ask answers later, and its test awaits it.
const handleHub = (...a: Parameters<typeof route>) => route(...a) as HubReply | undefined

const live = (token: string, sessionId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ token, kind: 'live', sessionId, cwd: '/w', limits: [{ kind: 'five_hour', percentUsed: 41 }], tokens: 82000, ...extra })

describe('hub feed', () => {
  it('ignores a post without the token', () => {
    const hub = new HubService()
    const reply = handleHub(hub, 'POST', '/hub', live('wrong', 's1'))
    assert.equal(reply?.status, 403)
    assert.equal(hub.get().live.length, 0)
  })

  it('merges a live post and replaces the same session on the next one', () => {
    const hub = new HubService()
    handleHub(hub, 'POST', '/hub', live(hub.token, 's1'))
    handleHub(hub, 'POST', '/hub', live(hub.token, 's1', { tokens: 90000 }))
    assert.equal(hub.get().live.length, 1)
    assert.equal(hub.get().live[0].tokens, 90000)
  })

  it('takes the old feed kinds and keeps nothing of them, so an older mod is not sent looking again', () => {
    const hub = new HubService()
    const before = JSON.stringify(hub.get())
    for (const kind of ['diet', 'guard', 'agent']) assert.equal(hub.ingest({ token: hub.token, kind, detail: 'x' }), true)
    assert.equal(JSON.stringify(hub.get()), before)
  })

  it('drops a live session silent for ten minutes', () => {
    const hub = new HubService()
    hub.ingest(JSON.parse(live(hub.token, 'old')), 0)
    hub.ingest(JSON.parse(live(hub.token, 'new')), 11 * 60 * 1000)
    assert.deepEqual(hub.get().live.map(s => s.sessionId), ['new'])
  })

  it('answers a bad body and an unknown route plainly', () => {
    const hub = new HubService()
    assert.equal(handleHub(hub, 'POST', '/hub', '{nope')?.status, 400)
    assert.equal(handleHub(hub, 'GET', '/hub/other', '')?.status, 404)
    assert.equal(handleHub(hub, 'POST', '/hooks', '{}'), undefined)
  })
})

describe('hub inbox', () => {
  it('hands each queued item over once, to its own chat only', () => {
    const hub = new HubService()
    hub.queue('s1', { kind: 'prompt', text: 'run the tests' })
    hub.queue('s2', { kind: 'rc' })
    const first = handleHub(hub, 'GET', `/hub/inbox?session=s1&token=${hub.token}`, '')
    assert.equal(first?.status, 200)
    const items = JSON.parse(first!.body)
    assert.equal(items.length, 1)
    assert.equal(items[0].text, 'run the tests')
    assert.deepEqual(JSON.parse(handleHub(hub, 'GET', `/hub/inbox?session=s1&token=${hub.token}`, '')!.body), [])
    assert.equal(JSON.parse(handleHub(hub, 'GET', `/hub/inbox?session=s2&token=${hub.token}`, '')!.body)[0].kind, 'rc')
  })

  it('refuses the inbox without the token', () => {
    const hub = new HubService()
    hub.queue('s1', { kind: 'prompt', text: 'x' })
    assert.equal(handleHub(hub, 'GET', '/hub/inbox?session=s1&token=nope', '')?.status, 403)
    assert.equal(hub.take('s1').length, 1)
  })
})

describe('message box reach', () => {
  const row = (ai?: 'claude' | 'codex') => ({ pid: 1, sessionId: 's1', cwd: '/w', link: '', live: true, why: [], ai })
  it('counts a Claude chat as taking messages only while its mod polls the inbox', () => {
    const hub = new HubService()
    assert.equal(hub.takes(row(), false, 1_000), false)
    hub.take('s1', 1_000)
    assert.equal(hub.takes(row('claude'), false, 5_000), true)
    assert.equal(hub.takes(row(), false, 20_000), false)
  })

  it('counts a Codex chat as taking messages only with a terminal tied to it', () => {
    const hub = new HubService()
    hub.take('s1', 1_000)
    assert.equal(hub.takes(row('codex'), false, 1_000), false)
    assert.equal(hub.takes(row('codex'), true, 1_000), true)
  })

  it('never counts a chat that is not live', () => {
    const hub = new HubService()
    hub.take('s1', 1_000)
    assert.equal(hub.takes({ ...row('claude'), live: false }, false, 1_000), false)
    assert.equal(hub.takes({ ...row('codex'), live: false }, true, 1_000), false)
  })
})

describe('keep working', () => {
  it('queues a compaction for one chat', () => {
    const hub = new HubService()
    hub.queue('s1', { kind: 'compact' })
    assert.equal(hub.take('s1')[0].kind, 'compact')
  })
})

describe('contract', () => {
  it('keeps the extension and webview copies of the hub types identical', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const body = (p: string) => fs.readFileSync(path.join(__dirname, p), 'utf8').split('\n').slice(8).join('\n')
    assert.equal(body('../src/hub/types.ts'), body('../../web/lib/hub-types.ts'))
  })
})


describe('handoff', () => {
  it('tells the mod which way a full chat goes, to the token holder only', () => {
    const h = new HubService()
    h.set({ keep: { ...h.get().keep, onFull: 'fresh', freshBranch: true } })
    assert.equal(handleHub(h, 'GET', '/hub/keep?token=nope', '')?.status, 403)
    const ok = handleHub(h, 'GET', `/hub/keep?token=${h.token}`, '')
    assert.deepEqual(JSON.parse(ok!.body), { onFull: 'fresh', freshBranch: true })
  })

  it('passes on a handoff whose note sits in the handoffs folder, and refuses others', () => {
    const h = new HubService()
    const seen: unknown[] = []
    h.onHandoff(x => seen.push(x))
    const home = os.homedir().replace(/\\/g, '/')
    assert.ok(h.ingest({ token: h.token, kind: 'handoff', sessionId: 's1', cwd: '/u/Armasu', note: `${home}/.claude/handoffs/Armasu/202610231015-s1.md`, branch: 'claude/x' }))
    assert.equal(h.ingest({ token: h.token, kind: 'handoff', sessionId: 's1', cwd: '/u/Armasu', note: '/etc/passwd' }), false)
    assert.equal(h.ingest({ token: h.token, kind: 'handoff', sessionId: 's1', cwd: '/u/Armasu', note: `${home}/.claude/handoffs/../../x.md` }), false)
    assert.deepEqual(seen, [{ sessionId: 's1', cwd: '/u/Armasu', note: `${home}/.claude/handoffs/Armasu/202610231015-s1.md`, branch: 'claude/x' }])
  })
})

describe('brain routes', () => {
  const seed = (hub: HubService) => {
    hub.set({ projects: [{ name: 'A', path: '/a', kind: 'repo', isOpen: true }, { name: 'B', path: '/b', kind: 'repo', isOpen: false }] })
    handleHub(hub, 'POST', '/hub', JSON.stringify({ token: hub.token, kind: 'live', sessionId: 'x', cwd: '/a', label: 'Shop', prompt: 'the shop', file: '/a/shop.ts' }))
    handleHub(hub, 'POST', '/hub', JSON.stringify({ token: hub.token, kind: 'live', sessionId: 'y', cwd: '/b', label: 'Far', prompt: 'far away' }))
  }

  it('refuses a brief without the token', () => {
    const hub = new HubService()
    assert.equal((handleHub(hub, 'GET', '/hub/brief?cwd=/a&token=no', '') as { status: number }).status, 403)
  })

  it('briefs a chat on its own project only', () => {
    const hub = new HubService()
    seed(hub)
    const reply = handleHub(hub, 'GET', `/hub/brief?cwd=/a&session=me&token=${hub.token}`, '') as { body: string }
    assert.match(reply.body, /Shop/)
    assert.doesNotMatch(reply.body, /Far|far away/)
  })

  it('records the latest file and keeps when it changed', () => {
    const hub = new HubService()
    seed(hub)
    const first = hub.get().live.find(s => s.sessionId === 'x')!.fileAt
    handleHub(hub, 'POST', '/hub', JSON.stringify({ token: hub.token, kind: 'live', sessionId: 'x', cwd: '/a', file: '/a/shop.ts' }))
    assert.equal(hub.get().live.find(s => s.sessionId === 'x')!.fileAt, first)
    assert.equal(board(hub.get()).length, 2)
  })

  it('asks with only the asking project on the board, and not when Ask is off', async () => {
    const hub = new HubService()
    seed(hub)
    let seen = ''
    const fake = async (_q: string, ctx: string) => { seen = ctx; return 'ok' }
    const reply = await handleHub(hub, 'GET', `/hub/ask?cwd=/a&q=who&token=${hub.token}`, '', fake)
    assert.equal(reply?.body, 'ok')
    assert.match(seen, /Shop/)
    assert.doesNotMatch(seen, /Far/)
    hub.set({ controls: { ...hub.get().controls, switchboard: { ...hub.get().controls.switchboard, askBrain: false } } })
    seen = ''
    const off = await handleHub(hub, 'GET', `/hub/ask?cwd=/a&q=who&token=${hub.token}`, '', fake)
    assert.match(off!.body, /off/)
    assert.equal(seen, '')
  })

  it('suggests a dev server that stopped, until it is back', () => {
    const hub = new HubService()
    const dev = { pid: 1, command: 'next dev', port: 3000, folder: '/a' }
    hub.set({ servers: [dev] })
    hub.set({ servers: [] })
    const servers = () => suggest(hub.get(), hub.stopped()).filter(s => s.kind === 'server').length
    assert.equal(servers(), 1)
    hub.set({ servers: [dev] })
    assert.equal(servers(), 0)
  })
})

describe('hub state and command routes', () => {
  it('answers the state only with the token', () => {
    const h = new HubService()
    assert.equal((handleHub(h, 'GET', '/hub/state?token=wrong', '') as { status: number }).status, 403)
    const ok = handleHub(h, 'GET', `/hub/state?token=${h.token}`, '') as { status: number; body: string }
    assert.equal(ok.status, 200)
    assert.deepEqual(JSON.parse(ok.body).chats, [])
    // The phone secret stays in the VS Code panel, never in the browser's state.
    h.set({ phoneUrls: { wifi: 'http://192.168.1.5:3131/?k=secret' }, thisWindow: '/g/agent-flow' })
    const again = handleHub(h, 'GET', `/hub/state?token=${h.token}`, '') as { body: string }
    assert.equal(JSON.parse(again.body).phoneUrls, null)
    // The browser app is no window, so it gets no "this window" tag.
    assert.equal(JSON.parse(again.body).thisWindow, undefined)
    assert.doesNotMatch(again.body, /secret/)
    // A read marks the hub as watched, so its chats keep refreshing with no panel open.
    assert.ok(h.stateReadAt > 0)
  })

  it('hands a hub command to the runner and refuses anything else', () => {
    const h = new HubService()
    const seen: unknown[] = []
    h.runner = c => { seen.push(c); return true }
    const post = (body: string) => (handleHub(h, 'POST', `/hub/command?token=${h.token}`, body) as { status: number }).status
    assert.equal(post(JSON.stringify({ type: 'hub-refresh' })), 204)
    assert.equal(post(JSON.stringify({ type: 'ready' })), 400)
    assert.equal(post('not json'), 400)
    assert.equal((handleHub(h, 'POST', '/hub/command?token=no', '{"type":"hub-refresh"}') as { status: number }).status, 403)
    assert.deepEqual(seen, [{ type: 'hub-refresh' }])
  })

  it('refuses a command whose fields are the wrong shape, and says why', () => {
    const h = new HubService()
    const seen: unknown[] = []
    h.runner = c => { seen.push(c); return true }
    const post = (c: unknown) => handleHub(h, 'POST', `/hub/command?token=${h.token}`, JSON.stringify(c)) as { status: number; body: string }
    const missing = post({ type: 'hub-send' })
    assert.equal(missing.status, 400)
    assert.match(missing.body, /sessionId/)
    assert.equal(post({ type: 'hub-send', sessionId: 's1', text: 7 }).status, 400)
    assert.equal(post({ type: 'hub-keep', onFull: 'later' }).status, 400)
    assert.equal(post({ type: 'hub-switchboard', key: '__proto__', value: true }).status, 400)
    assert.equal(post({ type: 'hub-layout', layout: 'x' }).status, 400)
    assert.equal(post({ type: 'hub-nope' }).status, 400)
    assert.equal(post({ type: 'hub-new-chat', path: '/a', remote: false, ai: 'gemini' }).status, 400)
    assert.equal(post({ type: 'hub-star', sessionId: 's1', ai: 'toString', on: true }).status, 400)
    assert.equal(post({ type: 'hub-resume', sessionId: 's1' }).status, 400)
    assert.equal(post({ type: 'hub-focus-chat' }).status, 400)
    assert.equal(post({ type: 'hub-open-note', note: '/etc/passwd' }).status, 400)
    assert.deepEqual(seen, [])
    assert.equal(post({ type: 'hub-keep', onFull: 'fresh' }).status, 204)
    assert.equal(post({ type: 'hub-new-chat', path: '/a', remote: false }).status, 204)
    assert.equal(post({ type: 'hub-setting', key: 'model', value: null }).status, 204)
    assert.equal(post({ type: 'hub-new-chat', path: '/a', remote: false, ai: 'codex' }).status, 204)
    assert.equal(post({ type: 'hub-star', sessionId: 's1', ai: 'claude', on: true }).status, 204)
    assert.equal(post({ type: 'hub-focus-chat', sessionId: 'abc' }).status, 204)
    assert.equal(post({ type: 'hub-open-note', sessionId: 'abc' }).status, 204)
    assert.equal(seen.length, 7)
    assert.equal(post({ type: 'hub-aws-window', profile: 3 }).status, 400)
    assert.equal(post({ type: 'hub-aws-add', profile: 'a' }).status, 400)
    assert.equal(post({ type: 'hub-aws-window', profile: null }).status, 204)
    assert.equal(post({ type: 'hub-aws-login', profile: 'live', chrome: 'Default' }).status, 204)
    assert.equal(post({ type: 'hub-aws-default', profile: 'live' }).status, 204)
    assert.equal(post({ type: 'hub-aws-label', profile: 'live', label: 'Me' }).status, 204)
    assert.equal(post({ type: 'hub-aws-add', profile: 'a', region: 'us-west-1' }).status, 204)
    assert.equal(post({ type: 'hub-aws-check' }).status, 204)
  })

  it('answers 400 with the reason when the runner refuses a command', () => {
    const h = new HubService()
    h.runner = () => 'Remote Control could not read settings.json'
    const r = handleHub(h, 'POST', `/hub/command?token=${h.token}`, '{"type":"hub-rc","on":true}') as { status: number; body: string }
    assert.equal(r.status, 400)
    assert.equal(r.body, 'Remote Control could not read settings.json')
  })

  it('answers 400 with the reason when the runner refuses later', async () => {
    const h = new HubService()
    h.runner = async () => 'that terminal is not running Codex'
    const r = await handleHub(h, 'POST', `/hub/command?token=${h.token}`, '{"type":"hub-send","sessionId":"s1","text":"hi"}')
    assert.equal(r?.status, 400)
    assert.equal(r?.body, 'that terminal is not running Codex')
  })

  it('has no hub-close command: only a handoff queues a close', () => {
    const h = new HubService()
    h.runner = () => true
    const r = handleHub(h, 'POST', `/hub/command?token=${h.token}`, '{"type":"hub-close","sessionId":"s1"}') as { status: number; body: string }
    assert.equal(r.status, 400)
    assert.match(r.body, /unknown command/)
  })

  it('answers 500 with the message when the runner throws', () => {
    const h = new HubService()
    h.runner = () => { throw new Error('boom') }
    const r = handleHub(h, 'POST', `/hub/command?token=${h.token}`, '{"type":"hub-refresh"}') as { status: number; body: string }
    assert.equal(r.status, 500)
    assert.equal(r.body, 'boom')
  })

  it('answers 503 while no runner is set', () => {
    const h = new HubService()
    assert.equal((handleHub(h, 'POST', `/hub/command?token=${h.token}`, '{"type":"hub-refresh"}') as { status: number }).status, 503)
  })
})

describe('close after handoff', () => {
  const note = `${os.homedir()}/.claude/handoffs/Armasu/1-old.md`
  it('closes the old chat once a new chat posts from the same folder', () => {
    const h = new HubService()
    h.ingest({ token: h.token, kind: 'live', sessionId: 'old', cwd: '/u/Armasu', limits: [] }, 1)
    h.ingest({ token: h.token, kind: 'handoff', sessionId: 'old', cwd: '/u/Armasu', note }, 2)
    // No close is armed until the fresh chat's terminal exists.
    h.ingest({ token: h.token, kind: 'live', sessionId: 'early', cwd: '/u/Armasu', limits: [] }, 3)
    assert.deepEqual(h.take('old'), [])
    h.closeAfterFresh('old', '/u/Armasu', 3)
    h.ingest({ token: h.token, kind: 'live', sessionId: 'old', cwd: '/u/Armasu', limits: [] }, 3)
    assert.deepEqual(h.take('old'), [])
    const closing: string[] = []
    h.onClosing(id => closing.push(id))
    h.ingest({ token: h.token, kind: 'live', sessionId: 'new', cwd: '/u/Armasu', limits: [] }, 4)
    assert.deepEqual(h.take('old').map(i => i.kind), ['close'])
    assert.deepEqual(closing, ['old'])
    h.ingest({ token: h.token, kind: 'live', sessionId: 'newer', cwd: '/u/Armasu', limits: [] }, 5)
    assert.deepEqual(h.take('old'), [])
  })

  it('leaves alone a chat already open in the folder before the handoff', () => {
    const h = new HubService()
    h.ingest({ token: h.token, kind: 'live', sessionId: 'second', cwd: '/u/Armasu', limits: [] }, 1)
    h.ingest({ token: h.token, kind: 'handoff', sessionId: 'old', cwd: '/u/Armasu', note }, 2)
    h.closeAfterFresh('old', '/u/Armasu', 2)
    h.ingest({ token: h.token, kind: 'live', sessionId: 'second', cwd: '/u/Armasu', limits: [] }, 3)
    assert.deepEqual(h.take('old'), [])
    h.ingest({ token: h.token, kind: 'live', sessionId: 'new', cwd: '/u/Armasu', limits: [] }, 4)
    assert.deepEqual(h.take('old').map(i => i.kind), ['close'])
  })

  it('leaves a chat in another folder alone', () => {
    const h = new HubService()
    h.ingest({ token: h.token, kind: 'handoff', sessionId: 'old', cwd: '/u/Armasu', note }, 2)
    h.closeAfterFresh('old', '/u/Armasu', 2)
    h.ingest({ token: h.token, kind: 'live', sessionId: 'other', cwd: '/u/agent-flow', limits: [] }, 4)
    assert.deepEqual(h.take('old'), [])
  })

  it('passes a plan along, refuses one outside a plain .md path, and always continues in a fresh chat', () => {
    const h = new HubService()
    assert.equal(h.get().keep.onFull, 'fresh')
    assert.deepEqual(h.get().archive, [])
    const got: unknown[] = []
    h.onHandoff(x => got.push(x.plan))
    assert.equal(h.ingest({ token: h.token, kind: 'handoff', sessionId: 'a', cwd: '/u/Armasu', note, plan: '/u/Armasu/docs/p.md' }), true)
    assert.equal(h.ingest({ token: h.token, kind: 'handoff', sessionId: 'a', cwd: '/u/Armasu', note, plan: '/u/../etc/p.md' }), false)
    assert.equal(h.ingest({ token: h.token, kind: 'handoff', sessionId: 'a', cwd: '/u/Armasu', note, plan: 'docs/p.md' }), false)
    assert.equal(h.ingest({ token: h.token, kind: 'handoff', sessionId: 'a', cwd: '/u/Armasu', note }), true)
    assert.deepEqual(got, ['/u/Armasu/docs/p.md', undefined])
  })

  it('tells the panel when a close failed', () => {
    const h = new HubService()
    const failed: string[] = []
    h.onCloseFailed(id => failed.push(id))
    assert.equal(h.ingest({ token: h.token, kind: 'close-failed', sessionId: 'old' }), true)
    assert.deepEqual(failed, ['old'])
  })

  it('tells the panel when a chat took a message from Switchboard, so its terminal comes up', () => {
    const h = new HubService()
    const prompted: string[] = []
    h.onPrompted(id => prompted.push(id))
    assert.equal(h.ingest({ token: h.token, kind: 'prompted', sessionId: 'c1' }), true)
    assert.equal(h.ingest({ token: h.token, kind: 'prompted' }), false)
    assert.deepEqual(prompted, ['c1'])
  })

  it('passes dev-start and dev-stop from another window on, a folder only', () => {
    const h = new HubService()
    const got: string[] = []
    h.onDev(d => got.push(`${d.kind} ${d.folder}`))
    assert.equal(h.ingest({ token: h.token, kind: 'dev-start', folder: '/r/QR-Test' }), true)
    assert.equal(h.ingest({ token: h.token, kind: 'dev-stop', folder: '/r/QR-Test' }), true)
    assert.equal(h.ingest({ token: h.token, kind: 'dev-start' }), false)
    assert.equal(h.ingest({ token: 'nope', kind: 'dev-start', folder: '/r/QR-Test' }), false)
    assert.deepEqual(got, ['start /r/QR-Test', 'stop /r/QR-Test'])
    assert.equal(commandProblem({ type: 'hub-dev-start', folder: '/r/QR-Test' }), undefined)
    assert.equal(commandProblem({ type: 'hub-dev-stop', folder: '/r/QR-Test' }), undefined)
    assert.equal(commandProblem({ type: 'hub-awake', on: true }), undefined)
    assert.match(commandProblem({ type: 'hub-dev-start' }) ?? '', /folder/)
  })
})

describe('jev runs', () => {
  const hook = (h: HubService, session_id: string, hook_event_name: string, extra: Record<string, unknown> = {}, now = 1) =>
    h.hook({ session_id, cwd: '/u/Armasu', hook_event_name, ...extra }, now)
  const run = { preset: 'triage-comments', items: 24, seconds: 7.2, costUsd: 0.0061, errors: 0 }

  it('keeps a run and draws it on the chat that ran jev.py', () => {
    const h = new HubService()
    hook(h, 'a', 'SessionStart', {}, 1)
    hook(h, 'b', 'SessionStart', {}, 2)
    hook(h, 'a', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'python3 ~/.claude/skills/claude-x-jev/scripts/jev.py ask --preset triage-comments' } }, 3)
    hook(h, 'b', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/u/x.ts' } }, 4)
    assert.equal(h.ingest({ token: h.token, kind: 'jev', ...run }, 5), true)
    assert.deepEqual(h.get().jev, [{ sessionId: 'a', preset: 'triage-comments', items: 24, seconds: 7.2, costUsd: 0.0061, at: 5 }])
    const a = h.get().progress.find(p => p.sessionId === 'a')!
    assert.deepEqual(a.roles, [{ id: 'jev', role: 'jev', state: 'done', startedAt: 5 }])
    assert.deepEqual(a.tools?.at(-1), { tool: 'triage-comments', target: '24 items · $0.0061', role: 'jev', at: 5 })
    assert.equal(h.get().progress.find(p => p.sessionId === 'b')!.roles.length, 0)
  })

  it('uses the session id when the mod sends one, and falls back to the newest chat', () => {
    const h = new HubService()
    hook(h, 'a', 'SessionStart', {}, 1)
    hook(h, 'b', 'SessionStart', {}, 2)
    h.ingest({ token: h.token, kind: 'jev', ...run, sessionId: 'a' }, 3)
    h.ingest({ token: h.token, kind: 'jev', ...run, preset: undefined }, 4)
    assert.deepEqual(h.get().jev.map(r => r.sessionId), ['b', 'a'])
    assert.equal(h.get().progress.find(p => p.sessionId === 'b')!.tools?.at(-1)?.tool, 'jev')
  })

  it('picks the chat in the posted folder when the session is not here, and draws on none when no chat is there', () => {
    const h = new HubService()
    h.hook({ session_id: 'arm', cwd: '/u/Armasu', hook_event_name: 'SessionStart' }, 1)
    h.hook({ session_id: 'flow', cwd: '/u/agent-flow', hook_event_name: 'SessionStart' }, 2)
    h.ingest({ token: h.token, kind: 'jev', ...run, sessionId: 'elsewhere', cwd: '/u/Armasu/web' }, 3)
    assert.equal(h.get().jev[0].sessionId, 'arm')
    h.ingest({ token: h.token, kind: 'jev', ...run, sessionId: 'elsewhere', cwd: '/u/other' }, 4)
    assert.equal(h.get().jev.length, 2)
    assert.equal(h.get().jev[0].sessionId, undefined)
    assert.equal(h.get().progress.find(p => p.sessionId === 'flow')!.roles.length, 0)
  })

  it('takes a credits-only post, refuses a bad run, and keeps at most 50 runs', () => {
    const h = new HubService()
    assert.equal(h.ingest({ token: h.token, kind: 'jev', run: false, creditsLeftUsd: 3 }), true)
    assert.deepEqual(h.get().jev, [])
    assert.equal(h.ingest({ token: h.token, kind: 'jev', items: 'x', costUsd: 1, seconds: 1 }), true)
    assert.deepEqual(h.get().jev, [])
    for (let i = 0; i < 60; i++) h.ingest({ token: h.token, kind: 'jev', ...run, preset: 'p;rm -rf' }, i)
    assert.equal(h.get().jev.length, 50)
    assert.equal(h.get().jev[0].preset, undefined)
  })
})

describe('handoff waits for running subagents', () => {
  const note = `${os.homedir()}/.claude/handoffs/Armasu/1-old.md`
  const hook = (h: HubService, hook_event_name: string, extra: Record<string, unknown> = {}, now = 1) =>
    h.hook({ session_id: 'old', cwd: '/u/Armasu', hook_event_name, ...extra }, now)

  it('holds the handoff while a subagent runs, says so, then passes it on when the last one stops', () => {
    const h = new HubService()
    const got: string[] = []
    h.onHandoff(x => got.push(x.sessionId))
    h.set({ chats: [{ pid: 1, sessionId: 'old', name: 'Fix login', cwd: '/u/Armasu', link: '', live: true, why: [] }] })
    hook(h, 'SessionStart', {}, 1)
    hook(h, 'SubagentStart', { agent_type: 'engineer', agent_id: 'e1' }, 2)
    hook(h, 'SubagentStart', { agent_type: 'qa', agent_id: 'q1' }, 3)
    hook(h, 'Stop', {}, 4)
    h.ingest({ token: h.token, kind: 'handoff', sessionId: 'old', cwd: '/u/Armasu', note }, 5)
    assert.deepEqual(got, [])
    assert.deepEqual(h.get().waits, [{ sessionId: 'old', tasks: 2, next: 'v2', since: 5 }])
    hook(h, 'SubagentStop', { agent_type: 'engineer', agent_id: 'e1' }, 6)
    assert.deepEqual(got, [])
    assert.equal(h.get().waits[0].tasks, 1)
    hook(h, 'SubagentStop', { agent_type: 'qa', agent_id: 'q1' }, 7)
    assert.deepEqual(got, ['old'])
    assert.deepEqual(h.get().waits, [])
  })

  it('goes ahead after 30 minutes even if a subagent never reported back', () => {
    const h = new HubService()
    const got: string[] = []
    h.onHandoff(x => got.push(x.sessionId))
    hook(h, 'SubagentStart', { agent_type: 'engineer', agent_id: 'e1' }, 1)
    h.ingest({ token: h.token, kind: 'handoff', sessionId: 'old', cwd: '/u/Armasu', note }, 2)
    h.set({}, 2 + 29 * 60_000)
    assert.deepEqual(got, [])
    h.set({}, 2 + 30 * 60_000)
    assert.deepEqual(got, ['old'])
  })

  it('names each subagent still running at the cap, so the fresh chat can check it', () => {
    const h = new HubService()
    const got: Array<string[] | undefined> = []
    h.onHandoff(x => got.push(x.running))
    hook(h, 'SubagentStart', { agent_type: 'engineer', agent_id: 'e1' }, 1)
    h.ingest({ token: h.token, kind: 'handoff', sessionId: 'old', cwd: '/u/Armasu', note }, 2)
    h.set({}, 2 + 30 * 60_000)
    assert.deepEqual(got, [['engineer e1']])
  })

  it('passes it on once the lead stops its last subagent with TaskStop', () => {
    const h = new HubService()
    const got: string[] = []
    h.onHandoff(x => got.push(x.sessionId))
    hook(h, 'SubagentStart', { agent_type: 'engineer', agent_id: 'e1' }, 1)
    h.ingest({ token: h.token, kind: 'handoff', sessionId: 'old', cwd: '/u/Armasu', note }, 2)
    hook(h, 'PostToolUse', { tool_name: 'TaskStop', tool_input: { task_id: 'e1' }, tool_response: { task_id: 'e1' } }, 3)
    assert.deepEqual(got, ['old'])
  })

  it('stops waiting when the chat is about to compact, naming what still runs', () => {
    const h = new HubService()
    const got: Array<string[] | undefined> = []
    h.onHandoff(x => got.push(x.running))
    hook(h, 'SubagentStart', { agent_type: 'engineer', agent_id: 'e1' }, 1)
    h.ingest({ token: h.token, kind: 'handoff', sessionId: 'old', cwd: '/u/Armasu', note }, 2)
    h.ingest({ token: h.token, kind: 'live', sessionId: 'old', cwd: '/u/Armasu', tokens: 900, compactAt: 1000, limits: [] }, 3)
    assert.deepEqual(got, [])
    h.ingest({ token: h.token, kind: 'live', sessionId: 'old', cwd: '/u/Armasu', tokens: 970, compactAt: 1000, limits: [] }, 4)
    assert.deepEqual(got, [['engineer e1']])
  })

  it('goes at once when Kenneth asks for the handoff, before or after the note arrives', () => {
    const h = new HubService()
    const got: string[] = []
    h.onHandoff(x => got.push(x.sessionId))
    hook(h, 'SubagentStart', { agent_type: 'engineer', agent_id: 'e1' }, 1)
    h.ingest({ token: h.token, kind: 'handoff', sessionId: 'old', cwd: '/u/Armasu', note }, 2)
    h.handoffNow('old', 3)
    assert.deepEqual(got, ['old'])
    h.handoffNow('new', 4)
    h.hook({ session_id: 'new', cwd: '/u/Armasu', hook_event_name: 'SubagentStart', agent_type: 'qa', agent_id: 'q1' }, 5)
    h.ingest({ token: h.token, kind: 'handoff', sessionId: 'new', cwd: '/u/Armasu', note }, 6)
    assert.deepEqual(got, ['old', 'new'])
  })

  it('goes at once when the mod says Kenneth asked for it in another window', () => {
    const h = new HubService()
    const got: string[] = []
    h.onHandoff(x => got.push(x.sessionId))
    hook(h, 'SubagentStart', { agent_type: 'engineer', agent_id: 'e1' }, 1)
    h.ingest({ token: h.token, kind: 'handoff', sessionId: 'old', cwd: '/u/Armasu', note, force: true }, 2)
    assert.deepEqual(got, ['old'])
  })

  it('does not close the old chat while a subagent of it still runs', () => {
    const h = new HubService()
    hook(h, 'SessionStart', {}, 1)
    h.ingest({ token: h.token, kind: 'handoff', sessionId: 'old', cwd: '/u/Armasu', note }, 2)
    h.closeAfterFresh('old', '/u/Armasu', 2)
    hook(h, 'SubagentStart', { agent_type: 'engineer', agent_id: 'e1' }, 3)
    h.ingest({ token: h.token, kind: 'live', sessionId: 'new', cwd: '/u/Armasu', limits: [] }, 4)
    assert.deepEqual(h.take('old'), [])
    hook(h, 'SubagentStop', { agent_type: 'engineer', agent_id: 'e1' }, 5)
    assert.deepEqual(h.take('old').map(i => i.kind), ['close'])
  })
})


describe('hub token', () => {
  it('refuses a token with the right length but other bytes instead of throwing', () => {
    const hub = new HubService()
    assert.equal(hub.isToken('é'.repeat(hub.token.length)), false)
    assert.equal(hub.isToken(hub.token), true)
  })
})

describe('device route', () => {
  const ask = { id: 'ab'.repeat(16), ip: '192.168.1.50', ua: 'iPhone Safari', network: 'Wi-Fi', port: 3131 }
  const post = (h: HubService, body: unknown, token = h.token) => handleHub(h, 'POST', `/hub/device?token=${token}`, JSON.stringify(body))!.status
  it('hands a well formed ask or its end to the window', () => {
    const h = new HubService()
    const seen: unknown[] = []
    h.onDevice = d => { seen.push(d) }
    assert.equal(post(h, ask), 204)
    assert.equal(post(h, { ...ask, network: 'Tailscale' }), 204)
    assert.equal(post(h, { id: ask.id, done: true }), 204)
    assert.deepEqual(seen, [ask, { ...ask, network: 'Tailscale' }, { id: ask.id, done: true }])
  })
  it('refuses a wrong token, a bad shape or no listener', () => {
    const h = new HubService()
    const seen: unknown[] = []
    h.onDevice = d => { seen.push(d) }
    assert.equal(post(h, ask, 'nope'), 403)
    for (const bad of [{ ...ask, id: 'short' }, { ...ask, network: 'LTE' }, { ...ask, port: '3131' }, { ...ask, port: 0 }, { ...ask, ua: 'x'.repeat(200) }, { ...ask, ip: 5 }, { id: ask.id, done: false }, null, 'x']) assert.equal(post(h, bad), 400, JSON.stringify(bad))
    assert.equal(handleHub(h, 'POST', `/hub/device?token=${h.token}`, '{')!.status, 400)
    assert.equal(handleHub(h, 'GET', `/hub/device?token=${h.token}`, '')!.status, 404)
    assert.deepEqual(seen, [])
    assert.equal(post(new HubService(), ask), 503)
  })
  it('keeps the asks out of the browser state', () => {
    const h = new HubService()
    h.set({ devices: [{ id: ask.id, ip: ask.ip, ua: ask.ua, network: 'Wi-Fi' }] })
    const r = handleHub(h, 'GET', `/hub/state?token=${h.token}`, '') as { body: string }
    assert.equal(JSON.parse(r.body).devices, undefined)
  })
})

describe('usage limit retry', () => {
  const hit = { session_id: 's1', cwd: '/r', hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'API Error: Rate limit reached' }
  const texts = (h: HubService, now: number) => h.take('s1', now).filter(i => i.kind === 'prompt').map(i => (i as { text: string }).text)

  it('queues one continue prompt a minute after the known reset', () => {
    const h = new HubService()
    const reset = new Date(10 * 60_000).toISOString()
    h.ingest({ token: h.token, kind: 'live', sessionId: 's1', cwd: '/r', limits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: reset }] }, 0)
    h.hook(hit, 1000)
    assert.deepEqual(texts(h, 10 * 60_000), [])
    const got = texts(h, 11 * 60_000)
    assert.equal(got.length, 1)
    assert.match(got[0], /^Switchboard: the usage limit reset\. Continue where you left off/)
    assert.deepEqual(texts(h, 12 * 60_000), [])
  })

  it('retries after 30 minutes with no known reset, and not for a mirror', () => {
    const h = new HubService()
    h.hook(hit, 0)
    assert.deepEqual(texts(h, 29 * 60_000), [])
    assert.equal(texts(h, 30 * 60_000).length, 1)
    const m = new HubService()
    m.hook(hit, 0, true)
    assert.deepEqual(texts(m, 60 * 60_000), [])
  })

  it('is dropped when the chat moves on or ends, kept through a prompt that may fail', () => {
    for (const next of [
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} },
      { hook_event_name: 'SessionEnd' },
    ]) {
      const h = new HubService()
      h.hook(hit, 0)
      h.hook({ session_id: 's1', cwd: '/r', ...next }, 1)
      assert.deepEqual(texts(h, 60 * 60_000), [], next.hook_event_name)
    }
    const h = new HubService()
    h.hook(hit, 0)
    h.hook({ session_id: 's1', cwd: '/r', hook_event_name: 'UserPromptSubmit' }, 1)
    assert.equal(texts(h, 60 * 60_000).length, 1)
  })

  const kept = (file: string) => { const h = new HubService(); h.keepRetries(file); return h }

  it('outlives a window reload through its file, and leaves it once sent or the chat ends', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-retry-')), 'retries.json')
    const t = Date.now()
    kept(file).hook(hit, t)
    const back = kept(file)
    assert.deepEqual(texts(back, t + 29 * 60_000), [])
    assert.equal(texts(back, t + 30 * 60_000).length, 1)
    assert.deepEqual(texts(kept(file), t + 60 * 60_000), [])
    kept(file).hook(hit, t)
    kept(file).hook({ session_id: 's1', cwd: '/r', hook_event_name: 'SessionEnd' }, t + 1)
    assert.deepEqual(texts(kept(file), t + 60 * 60_000), [])
  })

  it('a reload forgets a retry a day overdue: that chat is gone', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-retry-')), 'retries.json')
    fs.writeFileSync(file, JSON.stringify({ s1: Date.now() - 25 * 3600_000, s2: 'x' }))
    assert.deepEqual(kept(file).take('s1').filter(i => i.kind === 'prompt'), [])
  })

  it('sends none while Claude Code continues by itself (autoContinueAtUsageLimit), still warns', () => {
    const h = new HubService()
    h.set({ keep: { ...h.get().keep, autoContinue: true } }, 0)
    h.hook(hit, 0)
    assert.equal(h.get().progress[0].limited?.error, 'rate_limit')
    assert.deepEqual(texts(h, 60 * 60_000), [])
  })
})
