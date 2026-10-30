import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { HubService } from '../src/hub/hub-service'
import { handleHub, type HubReply } from '../src/hub/routes'
import { answerQuestion, askRegistered, choiceProblem, closeQuestion, installAsk, openQuestion, waitQuestion } from '../src/hub/questions'
import { askKeys, step } from '../src/hub/progress'
import type { Ask } from '../src/hub/types'

const hex = (n: number) => n.toString(16).padStart(32, '0')
let seq = 1
const fresh = () => hex(seq++)
const QS = [{ question: 'Pick a color', options: [{ label: 'Red' }, { label: 'Blue' }] }, { question: 'Which', options: [{ label: 'a' }, { label: 'b' }], multiSelect: true }]

function chat(hub: HubService, sessionId = 's1') {
  hub.hook({ session_id: sessionId, cwd: '/w', hook_event_name: 'SessionStart', source: 'startup' })
  return () => hub.get().progress.find(p => p.sessionId === sessionId)!
}
const post = (hub: HubService, body: object, token = hub.token) => handleHub(hub, 'POST', `/hub/question?token=${token}`, JSON.stringify(body)) as HubReply

describe('question store', () => {
  it('an answer before the wait comes back at once, and only once', async () => {
    const id = fresh()
    openQuestion(id, 's1', { id, kind: 'question', tool: 'ask', options: [] })
    assert.equal(answerQuestion(id, [1]), true)
    assert.deepEqual(await waitQuestion(id, 1000), [1])
    assert.equal(waitQuestion(id, 10), undefined)
    assert.equal(answerQuestion(id, [0]), false)
  })

  it('a wait times out empty, wakes on an answer, and ends on close', async () => {
    const id = fresh()
    openQuestion(id, 's1', { id, kind: 'question', tool: 'ask', options: [] })
    assert.equal(await waitQuestion(id, 10), undefined)
    const w = waitQuestion(id, 5000)
    answerQuestion(id, [0])
    assert.deepEqual(await w, [0])
    const id2 = fresh()
    openQuestion(id2, 's1', { id: id2, kind: 'question', tool: 'ask', options: [] })
    const w2 = waitQuestion(id2, 5000)
    assert.equal(closeQuestion(id2), 's1')
    assert.equal(await w2, undefined)
  })

  it('drops questions older than an hour', () => {
    const old = fresh()
    openQuestion(old, 's1', { id: old, kind: 'question', tool: 'ask', options: [] }, 0)
    const id = fresh()
    openQuestion(id, 's1', { id, kind: 'question', tool: 'ask', options: [] }, 3_600_001)
    assert.equal(waitQuestion(old, 1), undefined)
  })

  it('checks a choice against the questions: arrays only for multiSelect', () => {
    const ask: Ask = { id: 'x', kind: 'question', tool: 'ask', options: [], via: 'hub', questions: [{ question: 'q', options: ['a', 'b'] }, { question: 'm', options: ['a', 'b', 'c'], multiSelect: true }] }
    assert.equal(choiceProblem(ask, [1, [0, 2]]), undefined)
    assert.equal(choiceProblem(ask, [1, 2]), undefined)
    assert.ok(choiceProblem(ask, [[1], [0]]))
    assert.ok(choiceProblem(ask, [1]))
    assert.ok(choiceProblem(ask, [2, [0]]))
    assert.ok(choiceProblem(ask, [0, []]))
    assert.ok(choiceProblem(ask, [0, [3]]))
    assert.equal(choiceProblem(ask, [{ other: 'teal' }, { picks: [0], other: 'zed' }]), undefined)
    assert.equal(choiceProblem(ask, [0, { other: 'zed' }]), undefined)
    assert.ok(choiceProblem(ask, [{ picks: [0], other: 'x' }, [0]]))
    assert.ok(choiceProblem(ask, [{ other: '\x1b ' }, [0]]))
    assert.ok(choiceProblem(ask, [0, { picks: [5], other: 'x' }]))
    assert.ok(choiceProblem(ask, [0, [1, 1]]))
    assert.ok(choiceProblem(ask, [0, { picks: [2, 2], other: 'x' }]))
  })

  it('a terminal prompt refuses several picks on a single-select question', () => {
    const ask: Ask = { id: 'x', kind: 'question', tool: 'AskUserQuestion', options: [], questions: [{ question: 'q', options: ['a', 'b'] }] }
    assert.equal(typeof askKeys(ask, [[0]]), 'string')
  })
})

describe('question routes', () => {
  it('needs the token and a well formed question', () => {
    const hub = new HubService()
    assert.equal(post(hub, { sessionId: 's1', id: fresh(), questions: QS }, 'nope').status, 403)
    assert.equal(post(hub, { sessionId: 's1', id: 'short', questions: QS }).status, 400)
    assert.equal(post(hub, { sessionId: 's1', id: fresh(), questions: [] }).status, 400)
    assert.equal((handleHub(hub, 'GET', `/hub/question?token=no&id=${fresh()}`, '') as HubReply).status, 403)
    assert.equal((handleHub(hub, 'GET', `/hub/question?token=${hub.token}&id=${fresh()}`, '') as HubReply).status, 410)
  })

  it('a question shows as the chat ask, survives the lead moving on, and its answer reaches the poll', async () => {
    const hub = new HubService()
    const p = chat(hub)
    const id = fresh()
    assert.equal(post(hub, { sessionId: 's1', id, questions: QS }).status, 204)
    assert.equal(p().state, 'needs-you')
    assert.deepEqual(p().ask, { id, kind: 'question', tool: 'ask', options: [], via: 'hub', sub: true, questions: [{ question: 'Pick a color', options: ['Red', 'Blue'] }, { question: 'Which', options: ['a', 'b'], multiSelect: true }] })
    hub.hook({ session_id: 's1', cwd: '/w', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} })
    assert.equal(p().ask?.id, id)
    const poll = handleHub(hub, 'GET', `/hub/question?token=${hub.token}&id=${id}`, '') as Promise<HubReply>
    answerQuestion(id, [1, [0, 1]])
    const r = await poll
    assert.equal(r.status, 200)
    assert.deepEqual(JSON.parse(r.body), { choice: [1, [0, 1]] })
    assert.equal((handleHub(hub, 'GET', `/hub/question?token=${hub.token}&id=${id}`, '') as HubReply).status, 410)
  })

  it('a poll shows the ask again after a Stop wiped it; done drops it', async () => {
    const hub = new HubService()
    const p = chat(hub)
    const id = fresh()
    post(hub, { sessionId: 's1', id, questions: QS })
    hub.hook({ session_id: 's1', cwd: '/w', hook_event_name: 'Stop', last_assistant_message: 'waiting' })
    assert.equal(p().ask, undefined)
    const poll = handleHub(hub, 'GET', `/hub/question?token=${hub.token}&id=${id}`, '') as Promise<HubReply>
    assert.equal(p().ask?.id, id)
    assert.equal((handleHub(hub, 'POST', `/hub/question/done?token=${hub.token}&id=${id}`, '') as HubReply).status, 204)
    assert.equal(p().ask, undefined)
    assert.equal((await poll).status, 204)
  })

  it('an answer given between polls does not put the ask back, and the poll that hands it over drops it', async () => {
    const hub = new HubService()
    const p = chat(hub)
    const id = fresh()
    post(hub, { sessionId: 's1', id, questions: QS })
    assert.equal(answerQuestion(id, [0, [1]]), true)
    const r = await (handleHub(hub, 'GET', `/hub/question?token=${hub.token}&id=${id}`, '') as Promise<HubReply>)
    assert.equal(r.status, 200)
    assert.equal(p().ask, undefined)
    assert.equal(p().state, 'working')
  })

  it('the ask step keeps a hub ask that is not the lead own', () => {
    const ask: Ask = { id: 'h', kind: 'question', tool: 'ask', options: [], via: 'hub', sub: true, questions: [{ question: 'q', options: ['a', 'b'] }] }
    const p = step({ sessionId: 's', cwd: '/w', state: 'needs-you', roles: [], tasks: [], startedAt: 0, at: 0, ask, asks: [ask] }, { session_id: 's', cwd: '/w', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'u1', tool_input: {} }, 1)
    assert.equal(p?.ask?.id, 'h')
  })
})

describe('ask install', () => {
  it('knows when the server is registered', () => {
    assert.equal(askRegistered({ mcpServers: { switchboard: { command: 'node' } } }), true)
    assert.equal(askRegistered({ mcpServers: {} }), false)
    assert.equal(askRegistered(undefined), false)
  })

  it('copies changed files and registers once', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-install-'))
    const from = path.join(tmp, 'ext'), home = path.join(tmp, 'home')
    fs.mkdirSync(from); fs.mkdirSync(home)
    fs.writeFileSync(path.join(from, 'ask-core.mjs'), 'core')
    fs.writeFileSync(path.join(from, 'ask-server.mjs'), 'server')
    const added: string[] = []
    const server = installAsk(from, home, s => added.push(s))
    assert.equal(server, path.join(home, '.claude', 'switchboard', 'ask', 'ask-server.mjs'))
    assert.equal(fs.readFileSync(server, 'utf8'), 'server')
    assert.deepEqual(added, [server])
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { switchboard: {} } }))
    fs.writeFileSync(path.join(from, 'ask-server.mjs'), 'server 2')
    installAsk(from, home, s => added.push(s))
    assert.equal(fs.readFileSync(server, 'utf8'), 'server 2')
    assert.equal(added.length, 1)
  })
})
