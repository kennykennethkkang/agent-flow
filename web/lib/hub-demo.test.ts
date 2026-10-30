import { test } from 'node:test'
import assert from 'node:assert/strict'
import { demoApply, demoHub, demoTick } from './hub-demo'

test('a demo New chat puts a working chat on top, named from the goal', () => {
  const h = demoApply(demoHub(), { type: 'hub-new-chat', path: '/Users/k/Documents/GitHub/Armasu', text: 'fix the closet door animation on settings page', remote: false })
  assert.equal(h.chats[0].name, 'Fix the closet door animation')
  assert.equal(h.chats[0].cwd, '/Users/k/Documents/GitHub/Armasu')
  assert.equal(h.progress[0].sessionId, h.chats[0].sessionId)
  assert.equal(h.progress[0].state, 'working')
})

test('demoTick adds a tool call to the working chat, keeps them, and turns the roles', () => {
  let h = demoHub(0)
  for (let t = 0; t < 10; t++) h = demoTick(h, 1000 + t * 900)
  const w = h.progress.find(p => p.sessionId === 'd-work')!
  assert.ok((w.tools?.length ?? 0) >= 10)
  assert.equal(w.tools?.at(-1)?.at, 1000 + 9 * 900)
  assert.deepEqual(w.roles.filter(r => r.role !== 'jev').map(r => [r.id, r.state]), [['r1', 'done'], ['r2', 'active'], ['e1', 'active'], ['e2', 'active']])
  const qa = demoTick(h, 19_000).progress.find(p => p.sessionId === 'd-work')!
  assert.deepEqual(qa.roles.filter(r => r.role !== 'jev' && r.state === 'active').map(r => r.id), ['e2', 'q1', 'q2'])
  assert.equal(qa.tools?.at(-1)?.role, 'qa')
  assert.deepEqual(qa.tasks.map(t => t.status), ['completed', 'completed', 'completed', 'in_progress'])
  assert.deepEqual(h.progress.find(p => p.sessionId === 'd-done'), demoHub(0).progress.find(p => p.sessionId === 'd-done'))
  assert.ok(h.live.some(l => l.sessionId === 'd-work' && l.tokens && l.compactAt && l.costUsd))
})

test('the demo working chat opens with two engineers, a researcher and qa running, and one researcher done', () => {
  const w = demoHub(0).progress.find(p => p.sessionId === 'd-work')!
  const on = (role: string) => w.roles.filter(r => r.role === role && r.state === 'active').length
  assert.deepEqual([on('engineer'), on('researcher'), on('qa')], [2, 1, 1])
  assert.equal(w.roles.filter(r => r.role === 'researcher' && r.state === 'done').length, 1)
})

test('the demo answers Changes for a chat and History search in its notes', () => {
  const h = demoApply(demoHub(), { type: 'hub-changes', sessionId: 'd-work' })
  assert.equal(h.changes?.sessionId, 'd-work')
  assert.ok(h.changes!.files.length >= 3)
  assert.ok(h.changes!.files.some(f => f.diff) && h.changes!.files.some(f => f.note))
  const s = demoApply(h, { type: 'hub-search', q: 'Cookie' })
  assert.equal(s.search?.q, 'Cookie')
  assert.deepEqual(s.search?.hits.map(x => x.sessionId), ['d-fix-v3'])
  assert.match(s.search!.hits[0].snippet, /cookie/i)
  assert.equal(demoApply(s, { type: 'hub-search', q: ' ' }).search, null)
})

test('the demo working chat has a Jev bubble, and a tick now and then draws a Jev pill from it', () => {
  const h = demoHub(0)
  const w = h.progress.find(p => p.sessionId === 'd-work')!
  assert.ok(w.roles.some(r => r.role === 'jev' && r.state === 'done'))
  let t = h
  for (let i = 0; i < 12; i++) t = demoTick(t, 1000 + i * 900)
  const tw = t.progress.find(p => p.sessionId === 'd-work')!
  assert.ok(tw.roles.some(r => r.role === 'jev'), 'the tick keeps the Jev role')
  const pill = tw.tools!.find(c => c.role === 'jev')!
  assert.match(pill.target ?? '', /items · \$/)
  assert.ok(h.jev.length >= 2)
})

test('the demo Sign-ins: make default, rename, add, pick for this window', () => {
  let h = demoHub()
  assert.ok(h.aws.some(a => a.isDefault) && h.signIns.chrome.length > 0 && h.signIns.window)
  h = demoApply(h, { type: 'hub-aws-default', profile: 'yo' })
  assert.equal(h.aws.find(a => a.isDefault)?.account, h.aws.find(a => a.name === 'yo')?.account)
  h = demoApply(h, { type: 'hub-aws-label', profile: 'yo', label: 'Work' })
  assert.equal(h.aws.find(a => a.name === 'yo')?.label, 'Work')
  h = demoApply(h, { type: 'hub-aws-add', profile: 'new', region: 'us-east-2' })
  assert.equal(h.aws.find(a => a.name === 'new')?.status, 'never')
  h = demoApply(h, { type: 'hub-aws-window', profile: 'yo' })
  assert.equal(h.signIns.projects[h.signIns.window!], 'yo')
  h = demoApply(h, { type: 'hub-aws-window', profile: null })
  assert.equal(h.signIns.projects[h.signIns.window!], undefined)
})

test('the demo browser per project: set, system browser, forget', () => {
  let h = demoHub()
  const folder = h.signIns.window!, dir = h.signIns.chrome[0].dir
  h = demoApply(h, { type: 'hub-browser', folder, chrome: dir })
  assert.equal(h.signIns.browsers?.[folder], dir)
  h = demoApply(h, { type: 'hub-browser', folder, chrome: '' })
  assert.equal(h.signIns.browsers?.[folder], '')
  h = demoApply(h, { type: 'hub-browser', folder, chrome: null })
  assert.equal(folder in (h.signIns.browsers ?? {}), false)
})

test('a demo role model pick changes only that role', () => {
  const h = demoApply(demoHub(0), { type: 'hub-role-model', role: 'ops', model: 'haiku' })
  assert.equal(h.installed.find(i => i.name === 'ops')?.model, 'haiku')
  assert.equal(h.installed.find(i => i.name === 'qa')?.model, 'opus')
})

test('the demo shows a dev row per project, and Dev, Stop and Keep awake change it', () => {
  const h = demoHub(0)
  const qr = h.dev?.find(d => d.project === 'QR-Test')
  assert.ok(qr && !qr.port && h.tailscale)
  const on = demoApply(h, { type: 'hub-dev-start', folder: qr.folder }).dev?.find(d => d.folder === qr.folder)
  assert.ok(on?.port && on.link?.endsWith(`:${on.port + 10000}`))
  const off = demoApply(demoApply(h, { type: 'hub-dev-start', folder: qr.folder }), { type: 'hub-dev-stop', folder: qr.folder }).dev?.find(d => d.folder === qr.folder)
  assert.deepEqual(off, qr)
  assert.equal(demoApply(h, { type: 'hub-dev-start', folder: '/etc' }).dev, h.dev)
  assert.equal(demoApply(h, { type: 'hub-awake', on: true }).awake, true)
})

test('the demo applies to-do commands to its sample list, with one item a chat ticked off to put back', () => {
  const at = '/Users/k/GitHub/Armasu'
  let h = demoHub(0)
  const list = () => h.todos![at]
  assert.equal(list().ticked?.length, 1)
  h = demoApply(h, { type: 'hub-todo-remove', path: at, id: 'dt1' })
  assert.ok(!list().todo.some(t => t.id === 'dt1'))
  assert.equal(list().ticked?.[0].id, 'dt1')
  h = demoApply(h, { type: 'hub-todo-add', path: at, text: ' New one ' })
  assert.equal(list().todo.at(-1)?.text, 'New one')
  h = demoApply(h, { type: 'hub-todo-edit', path: at, id: 'dt4', text: 'Edited' })
  assert.equal(list().todo.find(t => t.id === 'dt4')?.text, 'Edited')
  const ticked = list().ticked![1]
  h = demoApply(h, { type: 'hub-todo-restore', path: at, id: ticked.id })
  assert.equal(list().ticked?.length, 1)
  assert.ok(list().todo.some(t => t.text === ticked.text && t.id !== ticked.id && t.from === ticked.from && t.before === ticked.before))
  h = demoApply(h, { type: 'hub-todo-run', path: at, ids: ['dt4'] })
  assert.ok(list().todo.find(t => t.id === 'dt4')?.chat)

  assert.equal(demoApply(h, { type: 'hub-todo-remove', path: '/nowhere', id: 'x' }), h)
})

test('the name setting round-trips in the demo, empty by default', () => {
  assert.equal(demoHub().controls.switchboard.name, '')
  const h = demoApply(demoHub(), { type: 'hub-switchboard', key: 'name', value: 'Kenneth' })
  assert.equal(h.controls.switchboard.name, 'Kenneth')
})

test('a demo run starts the picked item and its prerequisite, like the extension\'s runOrder', () => {
  const at = '/Users/k/GitHub/Armasu'
  const h = demoApply(demoHub(0), { type: 'hub-todo-run', path: at, ids: ['dt1'] })
  const todo = h.todos![at].todo, chat = todo.find(t => t.id === 'dt1')?.chat
  assert.ok(chat)
  assert.equal(todo.find(t => t.id === 'dt2')?.chat, chat)
  assert.equal(todo.find(t => t.id === 'dt4')?.chat, undefined)
})
