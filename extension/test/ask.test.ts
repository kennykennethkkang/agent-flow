import { after, afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import { spawn } from 'node:child_process'
// @ts-expect-error plain ESM, no types
import { checkInput, toSchema, fromContent, fromChoice, pickWindow } from '../ask/ask-core.mjs'

const color = { question: 'Pick a color', header: 'Color', options: [{ label: 'Red', description: 'warm' }, 'Blue'] }

describe('ask-core', () => {
  it('normalizes questions and refuses bad shapes', () => {
    assert.deepEqual(checkInput({ questions: [color] }), { questions: [{ header: 'Color', question: 'Pick a color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }] }] })
    assert.deepEqual(checkInput({ questions: [{ question: 'Q', options: ['a', 'b'], multiSelect: true }] }).questions[0].multiSelect, true)
    assert.equal(typeof checkInput({}), 'string')
    assert.equal(typeof checkInput({ questions: [] }), 'string')
    assert.equal(typeof checkInput({ questions: Array(5).fill(color) }), 'string')
    assert.equal(typeof checkInput({ questions: [{ question: 'Q', options: ['only'] }] }), 'string')
    assert.equal(typeof checkInput({ questions: [{ question: 'Q', options: ['a', 'b', 'c', 'd', 'e'] }] }), 'string')
    assert.equal(typeof checkInput({ questions: [{ question: '', options: ['a', 'b'] }] }), 'string')
    assert.equal(typeof checkInput({ questions: [{ question: 'Q', options: ['a', 'b'], multiSelect: 'yes' }] }), 'string')
    assert.equal(typeof checkInput({ questions: [{ question: 'Q', options: ['a', { label: 3 }] }] }), 'string')
  })

  it('builds one enum per question, an array for multiSelect, and an optional other', () => {
    const { questions } = checkInput({ questions: [{ question: 'Pick', options: ['Red', 'Blue'] }, { question: 'Which', options: ['a', 'b'], multiSelect: true }] })
    assert.deepEqual(toSchema(questions), {
      type: 'object',
      properties: {
        q1: { type: 'string', title: 'Question 1', description: 'Pick', enum: ['Red', 'Blue'] },
        q1_other: { type: 'string', title: 'Other (optional)' },
        q2: { type: 'array', title: 'Question 2', description: 'Which', items: { type: 'string', enum: ['a', 'b'] } },
        q2_other: { type: 'string', title: 'Other (optional)' },
      },
      required: ['q1', 'q2'],
    })
    assert.equal(toSchema(checkInput({ questions: [color] }).questions).properties.q1.title, 'Color')
  })

  it('turns a dialog reply into one line per question', () => {
    const { questions } = checkInput({ questions: [{ question: 'Pick', options: ['Red', 'Blue'] }, { question: 'Which', options: ['a', 'b'], multiSelect: true }] })
    assert.equal(fromContent(questions, { q1: 'Blue', q2: ['a', 'b'], q2_other: 'c too' }), '"Pick": Blue\n"Which": a, b; other: c too')
  })

  it('turns Switchboard indexes into labels', () => {
    const { questions } = checkInput({ questions: [{ question: 'Pick', options: ['Red', 'Blue'] }, { question: 'Which', options: ['a', 'b'], multiSelect: true }] })
    assert.equal(fromChoice(questions, [1, [0, 1]]), '"Pick": Blue\n"Which": a, b')
    assert.equal(fromChoice(questions, [{ other: 'teal\nish' }, { picks: [1], other: 'zed' }]), '"Pick": (none); other: teal ish\n"Which": b; other: zed')
  })

  it('picks the window holding cwd, longest first, else the lowest live pid', () => {
    const w = (pid: number, workspace: string) => ({ pid, workspace, port: pid, hubToken: 't' })
    const files = [w(30, '/a'), w(20, '/a/b'), w(10, '/z'), w(5, '/a/b/c')]
    const alive = (pid: number) => pid !== 5
    assert.equal(pickWindow(files, '/a/b/x', alive).pid, 20)
    assert.equal(pickWindow(files, '/a/bb', alive).pid, 30)
    assert.equal(pickWindow(files, '/q', alive).pid, 10)
    assert.equal(pickWindow([], '/q', alive), undefined)
  })

  it('matches a Windows window whatever the drive letter case and slashes', () => {
    const w = (pid: number, workspace: string) => ({ pid, workspace, port: pid, hubToken: 't' })
    const files = [w(10, 'd:\\other'), w(20, 'c:\\Users\\k\\GitHub\\app')]
    assert.equal(pickWindow(files, 'C:\\Users\\k\\GitHub\\app\\web', () => true, 'win32').pid, 20)
    assert.equal(pickWindow(files, 'C:/Users/k/GitHub/app', () => true, 'win32').pid, 20)
    assert.equal(pickWindow(files, 'C:\\Users\\k\\GitHub\\apple', () => true, 'win32').pid, 10)
  })
})

// The real server over stdio, with HOME in a temp dir so the discovery file is a fake window.
// A stuck case fails on its timeout; afterEach still kills its child and closes its server, so npm test never hangs.
describe('ask-server', () => {
  const T = { timeout: 5000 }
  const server = path.join(__dirname, '..', 'ask', 'ask-server.mjs')
  const children: ReturnType<typeof spawn>[] = [], servers: http.Server[] = []
  const cleanup = () => {
    for (const c of children.splice(0)) c.kill('SIGKILL')
    for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() }
  }
  afterEach(cleanup)
  after(cleanup)

  function start(home: string, cwd: string) {
    const child = spawn(process.execPath, [server], { env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'sess1', CLAUDE_PROJECT_DIR: cwd }, stdio: ['pipe', 'pipe', 'inherit'] })
    children.push(child)
    const lines: Record<string, unknown>[] = []
    const waiters: Array<() => void> = []
    let buf = ''
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); waiters.splice(0).forEach(f => f()) }
    })
    const send = (m: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
    const next = async (f: (m: Record<string, unknown>) => boolean) => {
      for (;;) {
        const hit = lines.find(f)
        if (hit) { lines.splice(lines.indexOf(hit), 1); return hit as Record<string, any> }
        await new Promise<void>(r => waiters.push(r))
      }
    }
    return { child, send, next }
  }

  function fakeWindow(home: string, cwd: string, onPoll: (res: http.ServerResponse, n: number) => void) {
    const seen: Array<{ method?: string; url?: string; body: string }> = []
    let polls = 0
    const srv: http.Server = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body })
        if (req.method === 'GET') onPoll(res, polls++)
        else if (req.url?.startsWith('/hub/todo')) { res.writeHead(200); res.end('Added p1: Set up the db') }
        else { res.writeHead(204); res.end() }
      })
    })
    servers.push(srv)
    return new Promise<{ srv: http.Server; seen: typeof seen }>(resolve => srv.listen(0, '127.0.0.1', () => {
      const dir = path.join(home, '.claude', 'switchboard')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `x-${process.pid}.json`), JSON.stringify({ port: (srv.address() as { port: number }).port, pid: process.pid, workspace: cwd, hubToken: 'tok' }))
      resolve({ srv, seen })
    }))
  }

  async function init(s: ReturnType<typeof start>, elicit = true) {
    s.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: elicit ? { elicitation: {} } : {} } })
    assert.equal((await s.next(m => m.id === 1)).result.protocolVersion, '2025-06-18')
    s.send({ id: 2, method: 'tools/list' })
    assert.equal((await s.next(m => m.id === 2)).result.tools[0].name, 'ask')
    s.send({ id: 3, method: 'tools/call', params: { name: 'ask', arguments: { questions: [{ question: 'Pick a color', options: ['Red', 'Blue'] }] } } })
    return elicit ? s.next(m => m.method === 'elicitation/create') : undefined
  }
  const status = (code: number) => (res: http.ServerResponse) => { res.writeHead(code); res.end() }

  it('todo_add and todo_done post to the window with the token, cwd and session', T, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-'))
    const { srv, seen } = await fakeWindow(home, home, status(204))
    const s = start(home, home)
    try {
      s.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } })
      await s.next(m => m.id === 1)
      s.send({ id: 2, method: 'tools/list' })
      assert.deepEqual((await s.next(m => m.id === 2)).result.tools.map((t: { name: string }) => t.name), ['ask', 'todo_add', 'todo_done'])
      s.send({ id: 3, method: 'tools/call', params: { name: 'todo_add', arguments: { text: 'Set up the db', before_text: 'receipts' } } })
      assert.equal((await s.next(m => m.id === 3)).result.content[0].text, 'Added p1: Set up the db')
      const post = seen.find(r => r.url?.startsWith('/hub/todo'))!
      assert.equal(post.url, '/hub/todo?token=tok')
      assert.deepEqual(JSON.parse(post.body), { op: 'add', cwd: home, text: 'Set up the db', before: 'receipts', session: 'sess1' })
      s.send({ id: 4, method: 'tools/call', params: { name: 'todo_done', arguments: { id: 'p1', project: '/elsewhere' } } })
      await s.next(m => m.id === 4)
      assert.deepEqual(JSON.parse(seen.filter(r => r.url?.startsWith('/hub/todo'))[1].body), { op: 'done', cwd: '/elsewhere', id: 'p1', session: 'sess1' })
      s.send({ id: 5, method: 'tools/call', params: { name: 'todo_done', arguments: {} } })
      assert.equal((await s.next(m => m.id === 5)).result.isError, true)
    } finally { s.child.kill(); srv.close() }
  })

  it('a Switchboard answer wins: the dialog is cancelled and the answer returned', T, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-'))
    const { srv, seen } = await fakeWindow(home, home, (res, n) => {
      if (n === 0) { res.writeHead(204); res.end() } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choice: [1] })) }
    })
    const s = start(home, home)
    try {
      const el = await init(s)
      assert.match(el!.params.message, /Pick a color/)
      const result = await s.next(m => m.id === 3)
      assert.equal(result.result.content[0].text, '"Pick a color": Blue')
      const cancel = await s.next(m => m.method === 'notifications/cancelled')
      assert.equal(cancel.params.requestId, el!.id)
      const post = seen.find(r => r.method === 'POST')!
      assert.match(post.url!, /^\/hub\/question\?token=tok$/)
      const body = JSON.parse(post.body)
      assert.equal(body.sessionId, 'sess1')
      assert.equal(body.questions[0].options[1].label, 'Blue')
      assert.ok(seen.some(r => r.method === 'GET' && r.url === `/hub/question?token=tok&id=${body.id}`))
    } finally { s.child.kill(); srv.close() }
  })

  it('a dialog answer wins: the hub is told done', T, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-'))
    const { srv, seen } = await fakeWindow(home, home, () => { /* hold the poll */ })
    const s = start(home, home)
    try {
      const el = await init(s)
      s.send({ id: el!.id, result: { action: 'accept', content: { q1: 'Red' } } })
      assert.equal((await s.next(m => m.id === 3)).result.content[0].text, '"Pick a color": Red')
      for (let i = 0; i < 50 && !seen.some(r => r.url?.startsWith('/hub/question/done')); i++) await new Promise(r => setTimeout(r, 20))
      const id = JSON.parse(seen.find(r => r.method === 'POST')!.body).id
      assert.ok(seen.findIndex(r => r.url?.startsWith('/hub/question/done')) > seen.findIndex(r => r.method === 'POST'))
      assert.ok(seen.some(r => r.method === 'POST' && r.url === `/hub/question/done?token=tok&id=${id}`))
      srv.closeAllConnections()
    } finally { s.child.kill(); srv.close() }
  })

  it('no dialog and the window lost the question: replies at once', T, async () => {
    for (const code of [410, 404]) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-'))
      const { srv } = await fakeWindow(home, home, status(code))
      const s = start(home, home)
      try {
        await init(s, false)
        assert.match((await s.next(m => m.id === 3)).result.content[0].text, /could not be shown.*Decide yourself/)
      } finally { s.child.kill(); srv.close() }
    }
  })

  it('a dialog error leaves Switchboard to answer', T, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-'))
    let answer: http.ServerResponse | undefined
    const { srv, seen } = await fakeWindow(home, home, res => { answer = res })
    const s = start(home, home)
    try {
      const el = await init(s)
      s.send({ id: el!.id, error: { code: -32601, message: 'no elicitation' } })
      for (let i = 0; i < 50 && !answer; i++) await new Promise(r => setTimeout(r, 20))
      await new Promise(r => setTimeout(r, 50))
      answer!.writeHead(200, { 'Content-Type': 'application/json' }); answer!.end(JSON.stringify({ choice: [0] }))
      assert.equal((await s.next(m => m.id === 3)).result.content[0].text, '"Pick a color": Red')
      assert.ok(!seen.some(r => r.url?.startsWith('/hub/question/done')))
    } finally { s.child.kill(); srv.close() }
  })

  it('a dialog error with no window: could not be shown', T, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-'))
    const s = start(home, home)
    try {
      const el = await init(s)
      s.send({ id: el!.id, error: { code: -32601, message: 'no elicitation' } })
      assert.match((await s.next(m => m.id === 3)).result.content[0].text, /could not be shown \(no elicitation\)/)
    } finally { s.child.kill() }
  })

  it('no window: the dialog alone, and a decline says to decide', T, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-'))
    const s = start(home, home)
    try {
      const el = await init(s)
      s.send({ id: el!.id, result: { action: 'decline' } })
      assert.match((await s.next(m => m.id === 3)).result.content[0].text, /declined.*Decide yourself/)
      s.send({ id: 4, method: 'tools/call', params: { name: 'ask', arguments: { questions: [] } } })
      assert.equal((await s.next(m => m.id === 4)).result.isError, true)
    } finally { s.child.kill() }
  })
})
