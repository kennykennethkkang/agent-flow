// Switchboard's ask tool, plus todo_add and todo_done: an MCP stdio server, no dependencies. The question goes to the terminal
// (an elicitation dialog) and to the Switchboard window at once; the first answer wins, the other is closed.
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { checkInput, toSchema, fromContent, fromChoice, pickWindow } from './ask-core.mjs'

const DECLINED = 'The user declined to answer. Decide yourself and say what you decided.'
const TOOL = {
  name: 'ask',
  description: 'Ask the user a question only they can answer, with 2 to 4 options each (same shape as AskUserQuestion). Works from subagents too. It shows in the terminal and in Switchboard; returns their answer.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array', minItems: 1, maxItems: 4,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            header: { type: 'string', description: 'A short label, a few words' },
            options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] } },
            multiSelect: { type: 'boolean' },
          },
          required: ['question', 'options'],
        },
      },
    },
    required: ['questions'],
  },
}

const project = { type: 'string', description: 'The project folder; defaults to this chat\'s' }
const TODO_TOOLS = [
  {
    name: 'todo_add',
    description: 'Add future work to the project\'s Switchboard to-do, kept across chats until done. With before_id or before_text it is a prerequisite: something that must be done before that item.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, before_id: { type: 'string', description: 'Id of the item this must come before' }, before_text: { type: 'string', description: 'Text of that item, when the id is not known' }, project }, required: ['text'] },
  },
  {
    name: 'todo_done',
    description: 'Mark a Switchboard to-do item done, by its id or its text. When your work completes any open to-do item, even one you were not asked to do, call todo_done with its id before you finish.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, project } },
  },
]

const out = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
const reply = (id, text, isError) => out({ id, result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } })
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

function findWindow() {
  const dir = path.join(os.homedir(), '.claude', 'switchboard')
  let cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  try { cwd = fs.realpathSync(cwd) } catch { /* keep as is */ }
  const files = []
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f === 'workspaces.json') continue
      try { files.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) } catch { /* broken file */ }
    }
  } catch { return undefined }
  return pickWindow(files, cwd, alive)
}

let canElicit = false
let nextId = 1
const pending = new Map() // our request id -> resolve
const calls = new Map() // the client's call id -> stop

/** Posts the question, then polls until the window answers. answer is null once the window cannot (gone, 404, 410, network). */
function askHub(win, id, questions, signal) {
  const base = `http://127.0.0.1:${win.port}/hub/question`
  const q = `?token=${encodeURIComponent(win.hubToken)}`
  const posted = fetch(base + q, { method: 'POST', body: JSON.stringify({ sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? '', id, questions }) }).then(r => r.ok, () => false)
  const poll = async () => {
    if (!await posted) return null
    for (;;) {
      const g = await fetch(`${base}${q}&id=${id}`, { signal })
      if (g.status === 200) return (await g.json()).choice ?? null
      if (g.status !== 204) return null
    }
  }
  const answer = poll().catch(() => null)
  // After the post, so done never reaches the window before its question.
  const done = () => posted.then(ok => ok && fetch(`${base}/done${q}&id=${id}`, { method: 'POST' })).catch(() => {})
  return { answer, done }
}

async function call(msg) {
  const input = checkInput(msg.params?.arguments)
  if (typeof input === 'string') return reply(msg.id, `Not asked: ${input}`, true)
  const { questions } = input
  const id = randomBytes(16).toString('hex')
  const ctl = new AbortController()
  const win = findWindow()
  if (!canElicit && !win) return reply(msg.id, 'No way to reach the user here. Decide yourself and say what you decided.', true)

  const eid = `sb-${nextId++}`
  const dialog = canElicit ? new Promise(resolve => pending.set(eid, resolve)) : Promise.resolve({ error: { message: 'no dialog in this client' } })
  if (canElicit) {
    const more = questions.length > 1 ? ` (and ${questions.length - 1} more)` : ''
    out({ id: eid, method: 'elicitation/create', params: { message: questions[0].question + more, requestedSchema: toSchema(questions) } })
  }
  const stopped = new Promise(resolve => calls.set(msg.id, () => resolve({ stop: true })))
  const h = win && askHub(win, id, questions, ctl.signal)
  const done = () => { ctl.abort(); h?.done() }

  // A side that fails drops out; the other may still answer. None left: say so, never hang.
  const sides = new Map([['dialog', dialog.then(m => ({ m }))], ['hub', (h ? h.answer : Promise.resolve(null)).then(choice => ({ choice }))], ['stop', stopped]])
  let why = 'no reply'
  for (;;) {
    const r = await Promise.race(sides.values())
    if (r.stop) { calls.delete(msg.id); pending.delete(eid); return done() }
    if ('choice' in r) {
      if (r.choice) {
        calls.delete(msg.id)
        ctl.abort()
        if (pending.delete(eid)) out({ method: 'notifications/cancelled', params: { requestId: eid, reason: 'answered in Switchboard' } })
        return reply(msg.id, fromChoice(questions, r.choice))
      }
      sides.delete('hub')
    } else {
      const res = r.m.result
      if (res?.action) {
        calls.delete(msg.id)
        done()
        return reply(msg.id, res.action === 'accept' ? fromContent(questions, res.content) : DECLINED)
      }
      why = r.m.error?.message ?? why
      sides.delete('dialog')
    }
    if (!sides.has('hub') && !sides.has('dialog')) {
      calls.delete(msg.id)
      done()
      return reply(msg.id, `The question could not be shown (${why}). Decide yourself and say what you decided.`)
    }
  }
}

/** todo_add or todo_done, through the window's /hub/todo. */
async function todo(msg) {
  const a = msg.params?.arguments ?? {}
  const s = v => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const add = msg.params.name === 'todo_add'
  if (add ? !s(a.text) : !s(a.id) && !s(a.text)) return reply(msg.id, add ? 'Not added: text is empty.' : 'Not changed: give the id or text of the item.', true)
  const win = findWindow()
  if (!win) return reply(msg.id, 'Switchboard is not running here, so the to-do was not changed.', true)
  const body = { op: add ? 'add' : 'done', cwd: s(a.project) ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), text: s(a.text), id: add ? undefined : s(a.id), before: add ? s(a.before_id) ?? s(a.before_text) : undefined, session: process.env.CLAUDE_CODE_SESSION_ID || undefined }
  const r = await fetch(`http://127.0.0.1:${win.port}/hub/todo?token=${encodeURIComponent(win.hubToken)}`, { method: 'POST', body: JSON.stringify(body) })
  const text = await r.text()
  return r.ok ? reply(msg.id, text) : reply(msg.id, `Not changed: ${text || `status ${r.status}`}`, true)
}

const rl = createInterface({ input: process.stdin })
rl.on('line', l => {
  let m
  try { m = JSON.parse(l) } catch { return }
  if (!m.method) {
    // A reply to our elicitation.
    pending.get(m.id)?.(m)
    pending.delete(m.id)
    return
  }
  if (m.method === 'initialize') {
    canElicit = !!m.params?.capabilities?.elicitation
    return out({ id: m.id, result: { protocolVersion: m.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'switchboard', version: '1' } } })
  }
  if (m.method === 'tools/list') return out({ id: m.id, result: { tools: [TOOL, ...TODO_TOOLS] } })
  if (m.method === 'tools/call') {
    if (m.params?.name === 'todo_add' || m.params?.name === 'todo_done') return void todo(m).catch(err => reply(m.id, `${m.params.name} failed: ${err.message}`, true))
    if (m.params?.name !== 'ask') return out({ id: m.id, error: { code: -32602, message: `Unknown tool ${m.params?.name}` } })
    return void call(m).catch(err => reply(m.id, `ask failed: ${err.message}`, true))
  }
  if (m.method === 'notifications/cancelled') return calls.get(m.params?.requestId)?.()
  if (m.id != null) out({ id: m.id, result: {} })
})
// The session ended: tell the window, then go.
rl.on('close', () => { for (const stop of calls.values()) stop() })
