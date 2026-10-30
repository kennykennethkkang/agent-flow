/**
 * Per-project to-do lists: merging, the finish rules, and the hidden ref against temp repos
 * with a temp bare remote. Never touches a real repo.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { addTodo, afterEnd, afterFinish, backInChat, laterOnly, parseKept, clearGone, editTodo, emptyDoc, finishPrompt, hostId, mergeDocs, moveChat, ownerRepo, parseDoneIds, readDoc, readOptIn, removeItem, setOptIn, startTodo, storeFor, syncDoc, syncMode, todoFinished, updateDoc, TODO_REF, remoteSeen, replaceRemote, runOrder, runMessage, toolStep, mentions, restoreTicked, projectOf, finishItem, parseDoc } from '../src/hub/todo'
import { commandProblem, handleHub } from '../src/hub/routes'
import { git } from '../src/hub/git'
import { HubService, hub } from '../src/hub/hub-service'
import type { ChatProgress, TodoDoc } from '../src/hub/types'

// The host id lands in a temp HOME, never the real ~/.claude.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-home-'))
process.env.HOME = HOME
process.env.USERPROFILE = HOME
after(() => fs.rmSync(HOME, { recursive: true, force: true }))

const chat = (over: Partial<ChatProgress> = {}): ChatProgress => ({ sessionId: 's1', cwd: '/p', state: 'done', roles: [], tasks: [], startedAt: 0, at: 0, ...over })

describe('todo project', () => {
  it('files a repo subfolder under the repo even when the subfolder is listed, so its items stay on one list', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-todo-proj-'))
    const was = hub.get().projects
    try {
      const repo = path.join(tmp, 'agent-flow'), sub = path.join(repo, 'extension'), plain = path.join(tmp, 'notes')
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
      fs.mkdirSync(sub)
      fs.mkdirSync(path.join(plain, 'a'), { recursive: true })
      hub.set({ projects: [{ name: 'extension', path: sub, kind: 'project', isOpen: false }, { name: 'notes', path: plain, kind: 'project', isOpen: false }] })
      assert.equal(projectOf(sub), repo)
      assert.equal(projectOf(path.join(plain, 'a')), plain)
      assert.equal(projectOf('/nowhere/x'), '/nowhere/x')
    } finally { hub.set({ projects: was }); fs.rmSync(tmp, { recursive: true, force: true }) }
  })
})

describe('todo merge', () => {
  it('unions by id, drops tombstones from either side, newer edit wins', () => {
    const a: TodoDoc = { version: 1, todo: [{ id: 't1', text: 'old', at: 1 }, { id: 't2', text: 'gone', at: 1 }], removed: { x: 5 } }
    const b: TodoDoc = { version: 1, todo: [{ id: 't1', text: 'new', at: 2, before: 't3', from: 's9' }, { id: 't3', text: 'b only', at: 1 }], removed: { t2: 3, x: 9 } }
    const m = mergeDocs(a, b, 10)
    assert.deepEqual(m.todo, [{ id: 't1', text: 'new', at: 2, before: 't3', from: 's9' }, { id: 't3', text: 'b only', at: 1 }])
    assert.deepEqual(m.removed, { x: 9, t2: 3 })
    assert.deepEqual(mergeDocs(b, a, 10).todo.map(t => t.text).sort(), ['b only', 'new'])
  })

  it('keeps an item marked done in the finished list, by the chat or by you, and puts it back', () => {
    let d = addTodo(emptyDoc(), 'Ship it', 1, 'aaaa1111')
    d = finishItem(d, 'aaaa1111', undefined, 2)
    assert.deepEqual(d.todo, [])
    assert.deepEqual(d.ticked, [{ id: 'aaaa1111', text: 'Ship it', at: 2 }])
    assert.ok(Object.hasOwn(d.removed, 'aaaa1111'))
    assert.deepEqual(parseDoc(JSON.stringify(d)).ticked, d.ticked)
    const t = toolStep(addTodo(emptyDoc(), 'Fix login', 1, 'bbbb2222'), { op: 'done', id: 'bbbb2222', session: 'c1' }, 3)
    assert.deepEqual(t.doc.ticked, [{ id: 'bbbb2222', text: 'Fix login', at: 3, by: 'c1' }])
    assert.deepEqual(restoreTicked(d, 'aaaa1111', 4, 'cccc3333').todo.map(x => x.text), ['Ship it'])
    assert.equal(finishItem(d, 'nope', undefined, 5), d)
  })

  it('unions ticked items by id, newest 10, and never brings back one put back', () => {
    const t = (id: string, at: number) => ({ id, text: id, at, by: 's1' })
    const a: TodoDoc = { version: 1, todo: [], removed: {}, ticked: [t('k1', 3), t('k2', 2)] }
    const b: TodoDoc = { version: 1, todo: [], removed: {}, ticked: [t('k2', 2), t('k3', 4)] }
    assert.deepEqual(mergeDocs(a, b, 10).ticked?.map(x => x.id), ['k3', 'k1', 'k2'])
    const back = restoreTicked(a, 'k1', 5, 'n1')
    const m = mergeDocs(back, b, 10)
    assert.deepEqual(m.ticked?.map(x => x.id), ['k3', 'k2'])
    assert.deepEqual(m.todo.map(x => x.id), ['n1'])
    assert.deepEqual(mergeDocs(m, a, 10).ticked?.map(x => x.id), ['k3', 'k2'])
    const lots: TodoDoc = { version: 1, todo: [], removed: {}, ticked: Array.from({ length: 12 }, (_, i) => t(`z${i}`, i)) }
    assert.equal(mergeDocs(lots, emptyDoc(), 20).ticked?.length, 10)
  })

  it('prunes tombstones older than 90 days', () => {
    const day = 24 * 60 * 60 * 1000, now = 100 * day
    const a: TodoDoc = { version: 1, todo: [], removed: { old: now - 91 * day, recent: now - 89 * day } }
    assert.deepEqual(mergeDocs(a, emptyDoc(), now).removed, { recent: now - 89 * day })
  })

  it('edits, removes with a tombstone and starts', () => {
    let d = addTodo(emptyDoc(), '  Ship the\nthing  ', 10, 'aa')
    assert.deepEqual(d.todo, [{ id: 'aa', text: 'Ship the thing', at: 10 }])
    d = startTodo(editTodo(d, 'aa', 'Ship it', 11), 'aa', 'sess', 12)
    assert.deepEqual(d.todo, [{ id: 'aa', text: 'Ship it', at: 12, chat: 'sess', host: hostId() }])
    d = removeItem(d, 'aa', 13)
    assert.deepEqual(d.todo, [])
    assert.equal(d.removed.aa, 13)
    assert.equal(addTodo(emptyDoc(), 'x'.repeat(2000), 1, 'b').todo[0].text.length, 300)
    assert.equal(addTodo(emptyDoc(), '   ', 1, 'b').todo.length, 0)
  })
})

describe('todo finish', () => {
  it('reads the done ids out of the model answer, known ids only', () => {
    assert.deepEqual(parseDoneIds('ab12cd34, ff00ff00', ['ab12cd34', 'ff00ff00', '11111111']), ['ab12cd34', 'ff00ff00'])
    assert.deepEqual(parseDoneIds('Done: [ab12cd34]\nzz99zz99', ['ab12cd34']), ['ab12cd34'])
    assert.deepEqual(parseDoneIds('none', ['ab12cd34']), [])
    assert.deepEqual(parseDoneIds('xab12cd34x', ['ab12cd34']), [])
    assert.deepEqual(parseDoneIds('AB12CD34', ['ab12cd34']), ['ab12cd34'])
  })

  it('adds the standup Left items once; open tasks stay on the chat, not the to-do', () => {
    const p = chat({ report: { done: ['did a'], left: ['Write docs', 'Deploy'] }, tasks: [{ id: '1', subject: 'Open task', status: 'pending' }, { id: '2', subject: 'Closed', status: 'completed' }] })
    const d = afterFinish(emptyDoc(), p, [], 5)
    assert.deepEqual(d.todo.map(l => [l.text, l.from]), [['Write docs', 's1'], ['Deploy', 's1']])
    assert.deepEqual(afterFinish(d, p, [], 6).todo, d.todo)
    // The same chat finishing again with a shorter Left list drops what it no longer lists.
    const again = afterFinish(d, chat({ report: { done: [], left: ['Deploy'] } }), [], 7)
    assert.deepEqual(again.todo.map(l => l.text), ['Deploy'])
  })

  it('keeps only the Left lines the model calls later work; a failed answer keeps them all', async () => {
    assert.deepEqual(parseKept('1, 3', 3), [0, 2])
    assert.deepEqual(parseKept('None.', 3), [])
    assert.equal(parseKept('not sure', 3), undefined)
    assert.deepEqual(parseKept('9', 3), undefined)
    const p = chat({ report: { done: ['x'], left: ['Deploy to prod', 'nothing open. Request the chart again', 'Add rate limits'] } })
    assert.deepEqual(await laterOnly(p, async () => '1,3'), ['Deploy to prod', 'Add rate limits'])
    assert.deepEqual(await laterOnly(p, async () => 'none'), [])
    assert.deepEqual(await laterOnly(p, async () => { throw new Error('x') }), p.report?.left)
  })

  it('a filter answer that drops a line the chat still lists never tombstones it', () => {
    const p = chat({ report: { done: ['x'], left: ['Deploy to prod'] } })
    const one = afterFinish(emptyDoc(), p, [], 1, ['Deploy to prod'])
    const two = afterFinish(backInChat(one, 's1', 2), p, [], 3, [])
    assert.deepEqual(two.todo.map(l => l.text), ['Deploy to prod'])
    assert.deepEqual(two.removed, {})
    // Dropped by the filter on its first Done: not added, and still free to be added later.
    const skipped = afterFinish(emptyDoc(), p, [], 1, [])
    assert.deepEqual(skipped.todo, [])
    assert.deepEqual(afterFinish(skipped, p, [], 2, ['Deploy to prod']).todo.map(l => l.text), ['Deploy to prod'])
  })

  it('takes a chat\'s Left items back while Kenneth keeps working in it, and its next Done settles them', () => {
    const p = chat({ report: { done: ['x'], left: ['Live test in two windows', 'Deploy'] } })
    const d = addTodo(afterFinish(emptyDoc(), p, [], 1), 'Kenneth item', 1, 'k1')
    const back = backInChat(d, 's1', 2)
    assert.deepEqual(back.todo.map(l => [l.text, l.chat]), [['Live test in two windows', 's1'], ['Deploy', 's1'], ['Kenneth item', undefined]])
    // It did the test; only Deploy is still left.
    const next = afterFinish(back, chat({ report: { done: ['tested'], left: ['Deploy'] } }), [], 3)
    assert.deepEqual(next.todo.map(l => [l.text, l.chat]), [['Deploy', undefined], ['Kenneth item', undefined]])
  })

  it('keeps an item a chat added with todo_add when that chat finishes', () => {
    const d = addTodo(emptyDoc(), 'Add rate limiting to the export route', 1, 'aaaa1111', { from: 's1' })
    assert.deepEqual(afterFinish(d, chat({ report: { done: ['x'], left: [] } }), [], 2).todo.map(l => l.id), ['aaaa1111'])
  })

  it('removes the Left ids the model named and keeps a ticked item gone', () => {
    const d: TodoDoc = { version: 1, todo: [{ id: 'aaaa1111', text: 'x', at: 1, from: 'old' }, { id: 'bbbb2222', text: 'y', at: 1, from: 'old' }], removed: {} }
    const after = afterFinish(d, chat({ sessionId: 's2', report: { done: ['x'], left: [] } }), ['aaaa1111'], 5)
    assert.deepEqual(after.todo.map(l => l.id), ['bbbb2222'])
    assert.equal(after.removed.aaaa1111, 5)
    const ticked = removeItem(afterFinish(emptyDoc(), chat({ report: { done: [], left: ['Z'] } }), [], 1), afterFinish(emptyDoc(), chat({ report: { done: [], left: ['Z'] } }), [], 1).todo[0].id, 2)
    assert.equal(afterFinish(ticked, chat({ report: { done: [], left: ['Z'] } }), [], 3).todo.length, 0)
  })

  it('keeps the last 10 items the model ticked, with the chat, and puts one back under a new id', () => {
    const d = startTodo(addTodo(addTodo(emptyDoc(), 'Fix login', 1, 'aaaa1111', { from: 'c0' }), 'Mine', 1, 'm1'), 'm1', 's1', 2)
    const out = afterFinish(d, chat({ report: { done: ['x'], left: ['Deploy'] } }), ['aaaa1111'], 5)
    // Only the model named one; the chat's own started item and Left lines are not undoable.
    assert.deepEqual(out.ticked, [{ id: 'aaaa1111', text: 'Fix login', at: 5, by: 's1', from: 'c0' }])
    const back = restoreTicked(out, 'aaaa1111', 6, 'bbbb2222')
    assert.deepEqual(back.ticked, undefined)
    assert.deepEqual(back.todo.find(t => t.id === 'bbbb2222'), { id: 'bbbb2222', text: 'Fix login', at: 6, from: 'c0' })
    assert.equal(back.removed.aaaa1111, 5)
    assert.equal(restoreTicked(back, 'aaaa1111', 7), back)
    let many = emptyDoc()
    for (let i = 0; i < 12; i++) many = afterFinish(addTodo(many, `T${i}`, i, `t${i}`), chat(), [`t${i}`], 10 + i)
    assert.deepEqual(many.ticked?.map(t => t.id), ['t11', 't10', 't9', 't8', 't7', 't6', 't5', 't4', 't3', 't2'])
  })

  it('marks a started item done when its chat finishes and Left does not mention it, keeps it open (not started) when Left does', () => {
    const d = startTodo(addTodo(emptyDoc(), 'Add the receipts page', 1, 't1'), 't1', 's1', 2)
    assert.deepEqual(afterFinish(d, chat({ report: { done: ['Receipts'], left: [] } }), [], 3).todo, [])
    assert.equal(afterFinish(d, chat({ report: { done: ['Receipts'], left: [] } }), [], 3).removed.t1, 3)
    // Left with other lines only: done, and the lines join the to-do.
    const other = afterFinish(d, chat({ report: { done: [], left: ['Deploy to staging'] } }), [], 3)
    assert.deepEqual(other.todo.map(t => [t.text, t.from]), [['Deploy to staging', 's1']])
    // Left mentions it: open again, not started, and no duplicate line.
    const kept = afterFinish(d, chat({ report: { done: [], left: ['Add the receipts page (needs the API key)'] } }), [], 3)
    assert.deepEqual(kept.todo, [{ id: 't1', text: 'Add the receipts page', at: 3 }])
    // Another chat finishing leaves it in progress.
    assert.equal(afterFinish(d, chat({ sessionId: 'other' }), [], 3).todo[0].chat, 's1')
  })

  it('matches a Left line to an item by text, loosely', () => {
    assert.equal(mentions('Add the receipts page (blocked)', 'add the receipts page'), true)
    assert.equal(mentions('Wire receipts page totals into export', 'Receipts page totals export'), true)
    assert.equal(mentions('Deploy to staging', 'Add the receipts page'), false)
  })

  it('asks about the older Left items only', () => {
    const prompt = finishPrompt([{ id: 'aaaa1111', text: 'Fix login', at: 1 }], chat({ report: { done: ['Fixed login'], left: [] }, asked: ['fix the login'] }))
    assert.match(prompt, /aaaa1111: Fix login/)
    assert.match(prompt, /Fixed login/)
    assert.match(prompt, /fix the login/)
  })
})

describe('todo handoff and stale chats', () => {
  it('moves an item to the fresh chat on a handoff', () => {
    const d = startTodo(addTodo(emptyDoc(), 'Goal', 1, 't1'), 't1', 'old', 2)
    assert.equal(moveChat(d, 'old', 'new', 3).todo[0].chat, 'new')
    assert.equal(moveChat(d, 'other', 'new', 3), d)
  })

  it('unmarks an item whose chat is gone from this machine, after a grace period', () => {
    const d = startTodo(startTodo(addTodo(addTodo(emptyDoc(), 'A', 1, 'a'), 'B', 1, 'b'), 'a', 'gone', 1000), 'b', 'live', 1000)
    const far = { ...d, todo: [...d.todo, { id: 'c', text: 'C', at: 1000, chat: 'elsewhere', host: 'otherhost' }] }
    const out = clearGone(far, new Set(['live']), 1000 + 10 * 60_000)
    assert.deepEqual(out.todo.map(t => [t.id, t.chat]), [['a', undefined], ['b', 'live'], ['c', 'elsewhere']])
    assert.equal(clearGone(d, new Set(), 1000 + 1000), d)
  })
})

describe('todo host id', () => {
  it('is random, kept in ~/.claude/switchboard/host-id, and stable', () => {
    const id = hostId()
    assert.match(id, /^[0-9a-f]{16}$/)
    assert.equal(fs.readFileSync(path.join(HOME, '.claude', 'switchboard', 'host-id'), 'utf8').trim(), id)
    assert.equal(hostId(), id)
  })
})

describe('todo sync gate', () => {
  it('reads owner and repo from GitHub remotes only', () => {
    assert.equal(ownerRepo('https://github.com/k/app.git'), 'k/app')
    assert.equal(ownerRepo('git@github.com:k/app.git'), 'k/app')
    assert.equal(ownerRepo('https://gitlab.com/k/app.git'), undefined)
  })

  it('syncs private repos, keeps public, unknown and non-GitHub ones local unless opted in, asks gh once', async () => {
    let calls = 0
    const gh = (answer: string | undefined) => async (args: string[]) => { calls++; assert.deepEqual(args, ['api', `repos/${args[1].slice(6)}`, '--jq', '.private']); return answer }
    const mode = (url: string, answer: string | undefined, optIn = {}) => syncMode('/f', url, optIn, gh(answer))
    assert.equal((await mode('git@github.com:k/priv.git', 'true')).state, 'synced')
    assert.equal((await mode('git@github.com:k/priv.git', 'false')).state, 'synced')
    assert.equal(calls, 1)
    assert.deepEqual(await mode('git@github.com:k/pub.git', 'false'), { state: 'local', why: 'public repo', canSync: true })
    assert.equal((await mode('git@github.com:k/err.git', undefined)).state, 'local')
    assert.equal((await mode('https://gitlab.com/k/x.git', 'true')).why, 'origin is not on GitHub')
    assert.deepEqual(await mode('', 'true'), { state: 'local', why: 'no origin remote' })
    assert.deepEqual(await mode('git@github.com:k/pub.git', 'false', { '/f': true }), { state: 'synced', canSync: true, optIn: true })
  })

  it('asks gh again after a failure, keeps a yes or no', async () => {
    let calls = 0
    const fail = async () => { calls++; throw new Error('offline') }
    assert.equal((await syncMode('/f', 'git@github.com:k/retry.git', {}, fail)).state, 'local')
    assert.equal((await syncMode('/f', 'git@github.com:k/retry.git', {}, async () => { calls++; return undefined })).state, 'local')
    assert.equal((await syncMode('/f', 'git@github.com:k/retry.git', {}, async () => { calls++; return 'true\n' })).state, 'synced')
    assert.equal((await syncMode('/f', 'git@github.com:k/retry.git', {}, fail)).state, 'synced')
    assert.equal(calls, 3)
  })

  it('keeps the opt-in choice in a file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-optin-')), 'todo-sync.json')
    setOptIn('/a', true, file); setOptIn('/b', true, file); setOptIn('/a', false, file)
    assert.deepEqual(readOptIn(file), { '/b': true })
    fs.writeFileSync(file, '{"__proto__": true, "/c": "yes"}')
    assert.deepEqual(readOptIn(file), {})
    fs.rmSync(path.dirname(file), { recursive: true })
  })
})

describe('todo end', () => {
  const tasks = [{ id: '1', subject: 'Open task', status: 'pending' as const }, { id: '2', subject: 'Closed', status: 'completed' as const }, { id: '3', subject: 'Already listed', status: 'in_progress' as const }]

  it('adds the standup Left items of a chat that ends unfinished, once, deduped by text, never its open tasks', () => {
    const d: TodoDoc = { ...emptyDoc(), todo: [{ id: 'x', text: 'already listed', at: 1, from: 'other' }] }
    const p = chat({ state: 'idle', tasks, report: { done: [], left: ['Docs', 'Already listed'] } })
    const after = afterEnd(d, p, 5)
    assert.deepEqual(after.todo.map(l => l.text), ['already listed', 'Docs'])
    assert.deepEqual(afterEnd(after, p, 6), after)
  })

  it('skips a chat that reached Done, and unmarks its To-do item', () => {
    const d = startTodo(addTodo(emptyDoc(), 'Goal', 1, 't1'), 't1', 's1', 2)
    assert.deepEqual(afterEnd(d, chat({ state: 'done', tasks }), 3), d)
    const none = afterEnd(d, chat({ state: 'idle', tasks }), 3)
    assert.deepEqual(none.todo, [{ id: 't1', text: 'Goal', at: 3 }])
  })

  it('the hub reports a real end, never a handoff or a mirror', () => {
    const hub = new HubService()
    const ended: string[] = []
    hub.onEnded(p => ended.push(p.sessionId))
    const run = (id: string, mirror = false) => {
      hub.hook({ session_id: id, cwd: '/w', hook_event_name: 'SessionStart', source: 'startup' }, 1, mirror)
      hub.hook({ session_id: id, cwd: '/w', hook_event_name: 'PreToolUse', tool_name: 'TaskCreate', tool_input: { subject: 'T' } }, 2, mirror)
    }
    run('real'); run('handed'); run('mirror', true)
    hub.closeAfterFresh('handed', '/w')
    for (const [id, mirror] of [['real', false], ['handed', false], ['mirror', true]] as const) hub.hook({ session_id: id, cwd: '/w', hook_event_name: 'SessionEnd' }, 3, mirror)
    assert.deepEqual(ended, ['real'])
  })
})

describe('todo storage', () => {
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  let root = '', a = '', b = '', plain = '', files = ''
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-todo-'))
    sh(root, 'init', '-q', '--bare', '-b', 'main', 'remote.git')
    for (const name of ['a', 'b']) {
      sh(root, 'clone', '-q', 'remote.git', name)
      const dir = path.join(root, name)
      sh(dir, 'config', 'user.email', 't@t'); sh(dir, 'config', 'user.name', 'T'); sh(dir, 'config', 'commit.gpgsign', 'false')
    }
    a = path.join(root, 'a'); b = path.join(root, 'b')
    fs.writeFileSync(path.join(a, 'one.txt'), '1\n')
    sh(a, 'add', '.'); sh(a, 'commit', '-qm', 'init'); sh(a, 'push', '-q', '-u', 'origin', 'main')
    sh(b, 'pull', '-q', 'origin', 'main')
    plain = path.join(root, 'plain'); fs.mkdirSync(plain)
    files = path.join(root, 'files')
  })
  after(() => fs.rmSync(root, { recursive: true, force: true }))

  it('writes and reads the ref without touching the working tree, index or HEAD', async () => {
    fs.writeFileSync(path.join(a, 'one.txt'), 'dirty\n')
    const head = sh(a, 'rev-parse', 'HEAD'), status = sh(a, 'status', '--porcelain')
    const s = await storeFor(a, files)
    assert.equal(s.root, fs.realpathSync(a))
    await updateDoc(s, d => addTodo(d, 'First', 1, 't1'))
    await updateDoc(s, d => addTodo(d, 'Second', 2, 't2'))
    assert.deepEqual((await readDoc(s)).todo.map(t => t.text), ['First', 'Second'])
    assert.equal(sh(a, 'rev-parse', 'HEAD'), head)
    assert.equal(sh(a, 'status', '--porcelain'), status)
    assert.equal(sh(a, 'rev-list', '--count', TODO_REF), '2')
    assert.equal(sh(a, 'ls-tree', '--name-only', TODO_REF), 'todo.json')
    assert.ok(!fs.existsSync(path.join(a, 'todo.json')))
    sh(a, 'checkout', '-q', '--', 'one.txt')
  })

  it('syncs two clones through the bare remote and merges both sides', async () => {
    const sa = await storeFor(a, files), sb = await storeFor(b, files)
    await syncDoc(sa)
    assert.ok(sh(path.join(root, 'remote.git'), 'rev-parse', TODO_REF))
    await syncDoc(sb)
    assert.deepEqual((await readDoc(sb)).todo.map(t => t.id), ['t1', 't2'])
    // Both edit while apart: b removes t1 and adds t3, a edits t2 later than b does.
    const t = Date.now()
    await updateDoc(sb, d => editTodo(addTodo(removeItem(d, 't1', t), 'From b', t, 't3'), 't2', 'b edit', t + 1))
    await updateDoc(sa, d => editTodo(d, 't2', 'a edit', t + 2))
    await syncDoc(sb)
    await syncDoc(sa)
    await syncDoc(sb)
    for (const s of [sa, sb]) assert.deepEqual((await readDoc(s)).todo.map(t => [t.id, t.text]), [['t2', 'a edit'], ['t3', 'From b']])
    assert.equal(sh(a, 'rev-parse', TODO_REF), sh(b, 'rev-parse', TODO_REF))
    assert.equal(sh(a, 'rev-list', '--merges', '--count', TODO_REF), '1')
    // A merge commit has both parents; a second sync with nothing new makes no commit.
    const tip = sh(a, 'rev-parse', TODO_REF)
    await syncDoc(sa); await syncDoc(sb)
    assert.equal(sh(a, 'rev-parse', TODO_REF), tip)
  })

  it('never adopts or pushes over a remote list it cannot read', async () => {
    const sa = await storeFor(a, files)
    await syncDoc(sa)
    const tip = sh(a, 'rev-parse', TODO_REF)
    const empty = execFileSync('git', ['mktree'], { cwd: a, input: '' }).toString().trim()
    const bad = execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit-tree', empty, '-p', tip, '-m', 'bad'], { cwd: a }).toString().trim()
    const bare = path.join(root, 'remote.git')
    sh(a, 'push', '-q', bare, `${bad}:${TODO_REF}`)
    assert.match((await syncDoc(sa)) ?? '', /remote list unreadable/)
    assert.equal(sh(a, 'rev-parse', TODO_REF), tip)
    assert.ok((await readDoc(sa)).todo.length)
    // Diverged too: no merge, no push.
    await updateDoc(sa, d => addTodo(d, 'after bad', Date.now(), 'ab'))
    const mine = sh(a, 'rev-parse', TODO_REF)
    assert.match((await syncDoc(sa)) ?? '', /remote list unreadable/)
    assert.equal(sh(a, 'rev-parse', TODO_REF), mine)
    assert.equal(sh(bare, 'rev-parse', TODO_REF), bad)
    sh(bare, 'update-ref', TODO_REF, tip)
    await updateDoc(sa, d => removeItem(d, 'ab', Date.now()))
    await syncDoc(sa)
  })

  it('replaces an unreadable remote list on request, only under the lease it saw, and no other ref', async () => {
    const sa = await storeFor(a, files)
    await syncDoc(sa)
    const tip = sh(a, 'rev-parse', TODO_REF), bare = path.join(root, 'remote.git')
    const empty = execFileSync('git', ['mktree'], { cwd: a, input: '' }).toString().trim()
    const badCommit = (m: string) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit-tree', empty, '-p', tip, '-m', m], { cwd: a }).toString().trim()
    const bad = badCommit('bad'), bad2 = badCommit('bad2')
    sh(a, 'push', '-q', bare, `${bad}:${TODO_REF}`)
    assert.match((await syncDoc(sa)) ?? '', /remote list unreadable/)
    assert.equal(await remoteSeen(sa.root!), bad)
    // A local branch commit never goes with it.
    const main = sh(bare, 'rev-parse', 'main')
    fs.writeFileSync(path.join(a, 'one.txt'), 'local only\n'); sh(a, 'commit', '-qam', 'local only')
    // Someone else moved it since: the lease refuses.
    sh(a, 'push', '-q', bare, `+${bad2}:${TODO_REF}`)
    assert.ok(await replaceRemote(sa.root!, bad))
    assert.equal(sh(bare, 'rev-parse', TODO_REF), bad2)
    assert.equal(await replaceRemote(sa.root!, 'not-a-sha'), 'not a commit id')
    assert.equal(await replaceRemote(sa.root!, bad2), undefined)
    assert.equal(sh(bare, 'rev-parse', TODO_REF), tip)
    assert.equal(sh(bare, 'rev-parse', 'main'), main)
    assert.equal(await syncDoc(sa), undefined)
    sh(a, 'reset', '-q', '--hard', 'HEAD~1')
  })

  it('allows no forced push but the leased to-do ref alone', async () => {
    const sha = 'a'.repeat(40), lease = `--force-with-lease=${TODO_REF}:${sha}`
    for (const args of [
      ['push', '--force', 'origin', 'main'],
      ['push', `--force-with-lease=refs/heads/main:${sha}`, 'origin', 'main:main'],
      ['push', lease, 'origin', `${TODO_REF}:${TODO_REF}`, 'main:main'],
      ['push', lease, 'origin', `+${TODO_REF}:${TODO_REF}`],
      ['push', lease, '--force', 'origin', `${TODO_REF}:${TODO_REF}`],
    ]) assert.equal((await git(a, args)).err, 'Switchboard never force pushes', args.join(' '))
  })

  it('keeps a repo with no origin local', async () => {
    const solo = path.join(root, 'solo')
    sh(root, 'init', '-q', 'solo')
    const s = await storeFor(solo, files)
    await updateDoc(s, d => addTodo(d, 'Solo', 1, 's'))
    await syncDoc(s)
    assert.deepEqual((await readDoc(s)).todo.map(t => t.text), ['Solo'])
  })

  it('loads an old doc\'s Left items as to-do items, keeping tombstones', async () => {
    const s = await storeFor(path.join(plain, 'old'), files)
    fs.mkdirSync(path.dirname(s.file!), { recursive: true })
    fs.writeFileSync(s.file!, JSON.stringify({ version: 1, todo: [{ id: 't1', text: 'Mine', at: 1 }], left: [{ id: 'l1', text: 'From a chat', at: 2, from: 'c1' }, { id: 't1', text: 'dup', at: 3 }, { id: 'l2', text: 'Ticked', at: 2 }], removed: { l2: 4 } }))
    const d = await readDoc(s)
    assert.deepEqual(d.todo, [{ id: 't1', text: 'Mine', at: 1 }, { id: 'l1', text: 'From a chat', at: 2, from: 'c1' }])
    assert.deepEqual(d.removed, { l2: 4 })
    assert.equal('left' in d, false)
  })

  it('syncs before, from and done tombstones between two devices', async () => {
    const sa = await storeFor(a, files), sb = await storeFor(b, files)
    await syncDoc(sa); await syncDoc(sb)
    const t = Date.now()
    await updateDoc(sa, d => toolStep(d, { op: 'add', text: 'Set up the db', before: 't2', session: 'cA' }, t, 'p1').doc)
    await updateDoc(sb, d => removeItem(addTodo(d, 'Later', t, 'f1', { from: 'cB' }), 't3', t))
    await syncDoc(sa); await syncDoc(sb); await syncDoc(sa)
    for (const s of [sa, sb]) {
      const d = await readDoc(s)
      assert.deepEqual(d.todo.map(x => [x.id, x.before, x.from]).sort(), [['f1', undefined, 'cB'], ['p1', 't2', 'cA'], ['t2', undefined, undefined]])
      assert.ok(d.removed.t3)
    }
  })

  it('reads ticked items and put-back tombstones back from disk', async () => {
    const s = await storeFor(path.join(plain, 'ticked'), files)
    await updateDoc(s, d => restoreTicked({ ...d, ticked: [{ id: 'k1', text: 'A', at: 1, by: 's1' }, { id: 'k2', text: 'B', at: 2, by: 's2' }] }, 'k1', 3, 'n1'))
    const d = await readDoc(s)
    assert.deepEqual(d.ticked, [{ id: 'k2', text: 'B', at: 2, by: 's2' }])
    assert.equal(d.removed['k1.back'], 3)
    assert.deepEqual(d.todo.map(t => t.id), ['n1'])
  })

  it('drops bad ids from a doc, keeps an id named like an Object member', async () => {
    const s = await storeFor(plain, path.join(root, 'bad'))
    fs.mkdirSync(path.dirname(s.file!), { recursive: true })
    fs.writeFileSync(s.file!, JSON.stringify({ version: 1, todo: [{ id: 'constructor', text: 'ok', at: 1 }, { id: 'a b', text: 'bad', at: 1 }, { id: 'x'.repeat(65), text: 'long', at: 1 }], left: [], removed: { __proto__: 5, 'a b': 1, good: 2 } }))
    const d = await readDoc(s)
    assert.deepEqual(d.todo.map(t => t.id), ['constructor'])
    assert.deepEqual(Object.keys(d.removed), ['good'])
    assert.deepEqual(mergeDocs(d, emptyDoc(), 3).todo.map(t => t.id), ['constructor'])
    // A broken file is an error, never an empty list that a write would save.
    fs.writeFileSync(s.file!, '{broken')
    await assert.rejects(readDoc(s))
    await assert.rejects(updateDoc(s, x => addTodo(x, 'new', 1)))
    assert.equal(fs.readFileSync(s.file!, 'utf8'), '{broken')
  })

  it('refuses to write over a ref it cannot read, and past the size cap', async () => {
    const r = path.join(root, 'odd')
    sh(root, 'init', '-q', 'odd')
    const s = await storeFor(r, files)
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: r, input: 'x' }).toString().trim()
    const tree = execFileSync('git', ['mktree'], { cwd: r, input: `100644 blob ${blob}\tother.txt\n` }).toString().trim()
    const c = execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit-tree', tree, '-m', 'x'], { cwd: r }).toString().trim()
    sh(r, 'update-ref', TODO_REF, c)
    await assert.rejects(readDoc(s))
    await assert.rejects(updateDoc(s, x => addTodo(x, 'new', 1)))
    assert.equal(sh(r, 'rev-parse', TODO_REF), c)
    sh(r, 'update-ref', '-d', TODO_REF)
    await updateDoc(s, x => ({ ...x, todo: Array.from({ length: 500 }, (_, i) => ({ id: `i${i}`, text: 't', at: 1 })) }))
    await assert.rejects(updateDoc(s, x => addTodo(x, 'one more', 2)))
    await updateDoc(s, x => removeItem(x, 'i0', Date.now()))
  })

  it('keeps a folder with no git in a file', async () => {
    const s = await storeFor(plain, files)
    assert.equal(s.root, undefined)
    assert.ok(s.file?.startsWith(files))
    await updateDoc(s, d => addTodo(d, 'Plain', 1, 'p'))
    assert.deepEqual((await readDoc(s)).todo.map(t => t.text), ['Plain'])
    await syncDoc(s)
  })

  it('a slower, older Done of the same chat never writes over a newer one', async () => {
    const s = await storeFor(fs.mkdtempSync(path.join(os.tmpdir(), 'race-')), fs.mkdtempSync(path.join(os.tmpdir(), 'race-files-')))
    const slow = todoFinished(s, chat({ sessionId: 'r1', report: { done: ['a'], left: ['Old A'] } }), () => new Promise(r => setTimeout(() => r('1'), 100)))
    await todoFinished(s, chat({ sessionId: 'r1', report: { done: ['b'], left: ['New B'] } }), async () => '1')
    await slow
    const d = await readDoc(s)
    assert.deepEqual(d.todo.map(l => l.text), ['New B'])
    assert.deepEqual(d.removed, {})
  })

  it('a finished chat adds its Left items and the model ticks older ones', async () => {
    const s = await storeFor(plain, files)
    // The Left filter keeps every line here; its own tests are above.
    const keep = (f: (q: string) => Promise<string>) => async (q: string) => q.startsWith("A coding chat's standup") ? '1, 2, 3, 4, 5' : f(q)
    await todoFinished(s, chat({ sessionId: 'c1', report: { done: [], left: ['Old thing'] } }), keep(async () => 'none'))
    const id = (await readDoc(s)).todo.find(t => t.text === 'Old thing')!.id
    let asked = ''
    await todoFinished(s, chat({ sessionId: 'c2', report: { done: ['Old thing done'], left: ['New thing'] } }), keep(async q => { asked = q; return id }))
    assert.match(asked, /Old thing/)
    assert.deepEqual((await readDoc(s)).todo.map(l => l.text), ['Plain', 'New thing'])
    // A failed model call removes nothing.
    await todoFinished(s, chat({ sessionId: 'c3', report: { done: ['x'], left: [] } }), keep(async () => { throw new Error('offline') }))
    assert.deepEqual((await readDoc(s)).todo.map(l => l.text), ['Plain', 'New thing'])
    // An item typed in by hand, or one this chat added itself, is ticked too; one in progress on a chat is not asked about.
    await updateDoc(s, d => startTodo(addTodo(addTodo(d, 'Mine', 2, 'm1', { from: 'c4' }), 'Busy', 2, 'b1'), 'b1', 'other', 3))
    await todoFinished(s, chat({ sessionId: 'c4', report: { done: ['did it'], left: [] } }), keep(async q => { asked = q; return 'p, m1, b1' }))
    assert.doesNotMatch(asked, /Busy/)
    assert.deepEqual((await readDoc(s)).todo.map(l => l.text), ['New thing', 'Busy'])
    // Finishing again with the same Left line keeps it, whatever the model says.
    asked = ''
    await todoFinished(s, chat({ sessionId: 'c2', report: { done: ['part of it'], left: ['New thing'] } }), keep(async q => { asked = q; return (await readDoc(s)).todo.map(l => l.id).join(',') }))
    assert.doesNotMatch(asked, /New thing/)
    assert.deepEqual((await readDoc(s)).todo.map(l => l.text), ['New thing', 'Busy'])
  })
})

describe('hub-todo route shapes', () => {
  it('checks every field', () => {
    assert.equal(commandProblem({ type: 'hub-todo-add', path: '/p', text: 'x' }), undefined)
    assert.equal(commandProblem({ type: 'hub-todo-edit', path: '/p', id: 'a', text: 'x' }), undefined)
    assert.equal(commandProblem({ type: 'hub-todo-remove', path: '/p', id: 'a' }), undefined)
    assert.equal(commandProblem({ type: 'hub-todo-run', path: '/p', ids: ['a', 'b'] }), undefined)
    assert.equal(commandProblem({ type: 'hub-todo-run', path: '/p', ids: ['a'], to: 's1' }), undefined)
    assert.match(commandProblem({ type: 'hub-todo-run', path: '/p', ids: [] }) ?? '', /ids/)
    assert.match(commandProblem({ type: 'hub-todo-run', path: '/p', ids: [1] }) ?? '', /ids/)
    assert.match(commandProblem({ type: 'hub-todo-add', path: '/p' }) ?? '', /text/)
    assert.equal(commandProblem({ type: 'hub-todo-sync', path: '/p', on: true }), undefined)
    assert.match(commandProblem({ type: 'hub-todo-sync', path: '/p', on: 'yes' }) ?? '', /on/)
    assert.equal(commandProblem({ type: 'hub-todo-replace', path: '/p', remote: 'a'.repeat(40) }), undefined)
    assert.match(commandProblem({ type: 'hub-todo-replace', path: '/p', remote: 'main' }) ?? '', /remote/)
    assert.equal(commandProblem({ type: 'hub-todo-restore', path: '/p', id: 'a' }), undefined)
    assert.match(commandProblem({ type: 'hub-todo-restore', path: '/p' }) ?? '', /id/)
  })
})

describe('todo run', () => {
  const list = [
    { id: 'a', text: 'Ship receipts', at: 1 },
    { id: 'p', text: 'Set up the db', at: 2, before: 'a' },
    { id: 'pp', text: 'Get the key', at: 3, before: 'p' },
    { id: 'b', text: 'Docs', at: 4 },
  ]
  it('runs open prerequisites first, each once, in list order', () => {
    assert.deepEqual(runOrder(list, ['a']).map(t => t.id), ['pp', 'p', 'a'])
    assert.deepEqual(runOrder(list, ['b', 'a', 'p']).map(t => t.id), ['pp', 'p', 'a', 'b'])
    assert.deepEqual(runOrder([{ id: 'x', text: 'X', at: 1, before: 'y' }, { id: 'y', text: 'Y', at: 1, before: 'x' }], ['x']).map(t => t.id), ['y', 'x'])
  })
  it('says the items as a numbered list with the rules', () => {
    assert.equal(runMessage(runOrder(list, ['a'])), [
      'Switchboard to-do, in this order:',
      '1. Get the key (id pp, needed first for 2)',
      '2. Set up the db (id p, needed first for 3)',
      '3. Ship receipts (id a)',
      '',
      'Do prerequisites first. When you find something that must be done before an item, add it to the to-do with the switchboard todo_add tool (before_id: that item\'s id) as a prerequisite, do it, then continue. Mark each item done with todo_done (its id) when it is finished.',
    ].join('\n'))
  })
})

describe('todo tool', () => {
  const d = startTodo(addTodo(addTodo(emptyDoc(), 'Ship receipts', 1, 'a'), 'Docs', 1, 'b'), 'a', 'c1', 2)
  it('adds a prerequisite before an item by id or text, in progress where that item is', () => {
    const r = toolStep(d, { op: 'add', text: 'Set up the db', before: 'receipts', session: 'c1' }, 5, 'p1')
    assert.deepEqual(r.doc.todo.at(-1), { id: 'p1', text: 'Set up the db', at: 5, before: 'a', chat: 'c1', host: hostId(), from: 'c1' })
    assert.match(r.said, /p1/)
    assert.equal(toolStep(d, { op: 'add', text: 'Later', session: 'c1' }, 5, 'f1').doc.todo.at(-1)?.chat, undefined)
    assert.throws(() => toolStep(d, { op: 'add', text: 'X', before: 'nothing like it' }), /no open to-do item/)
    assert.throws(() => toolStep(d, { op: 'add', text: ' ' }), /text/)
  })
  it('closes an item by id or text, with a tombstone', () => {
    assert.deepEqual(toolStep(d, { op: 'done', id: 'b' }, 6).doc.removed, { b: 6 })
    assert.deepEqual(toolStep(d, { op: 'done', text: 'ship receipts' }, 6).doc.todo.map(t => t.id), ['b'])
    assert.throws(() => toolStep(addTodo(d, 'Docs two', 1, 'c'), { op: 'done', text: 'doc' }), /2 items/)
  })
  it('the route needs the token and passes the call on', async () => {
    const hub = new HubService()
    const calls: unknown[] = []
    const fake = async (b: unknown) => { calls.push(b); return 'Added p1' }
    const body = JSON.stringify({ op: 'add', cwd: '/p', text: 'X' })
    assert.equal((await handleHub(hub, 'POST', '/hub/todo?token=nope', body, undefined, fake))?.status, 403)
    const ok = await handleHub(hub, 'POST', `/hub/todo?token=${hub.token}`, body, undefined, fake)
    assert.deepEqual([ok?.status, ok?.body], [200, 'Added p1'])
    assert.deepEqual(calls, [{ op: 'add', cwd: '/p', text: 'X' }])
    assert.equal((await handleHub(hub, 'POST', `/hub/todo?token=${hub.token}`, JSON.stringify({ op: 'zap', cwd: '/p' }), undefined, fake))?.status, 400)
    const bad = await handleHub(hub, 'POST', `/hub/todo?token=${hub.token}`, body, undefined, async () => { throw new Error('no open to-do item matches "x"') })
    assert.deepEqual([bad?.status, bad?.body], [400, 'no open to-do item matches "x"'])
  })
})
