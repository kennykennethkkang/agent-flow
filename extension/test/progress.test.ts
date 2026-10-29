import { test } from 'node:test'
import assert from 'node:assert/strict'
import { step, commitMessage, shouldNotify, notifyKey, notifyStep, canPrefill, plainText } from '../src/hub/progress'
import { HubService } from '../src/hub/hub-service'

const S = 'abc'
const ev = (hook_event_name: string, extra: Record<string, unknown> = {}) => ({ session_id: S, cwd: '/r', hook_event_name, ...extra })
const run = (events: Record<string, unknown>[]) => events.reduce((p, e, i) => step(p, e, 1000 + i), undefined as ReturnType<typeof step>)

test('a fresh chat is working', () => {
  assert.equal(run([ev('SessionStart')])?.state, 'working')
})

test('roles: start marks active, stop marks done, order kept', () => {
  const p = run([ev('SessionStart'), ev('SubagentStart', { agent_type: 'researcher' }), ev('SubagentStop', { agent_type: 'researcher' }), ev('SubagentStart', { agent_type: 'engineer' })])
  assert.deepEqual(p?.roles, [{ id: 'researcher', role: 'researcher', state: 'done', startedAt: 1001 }, { id: 'engineer', role: 'engineer', state: 'active', startedAt: 1003 }])
})

test('roles: one entry per subagent, keyed by agent id', () => {
  const p = run([
    ev('SessionStart'),
    ev('SubagentStart', { agent_type: 'engineer', agent_id: 'e1' }),
    ev('SubagentStart', { agent_type: 'engineer', agent_id: 'e2' }),
    ev('SubagentStart', { agent_type: 'engineer', agent_id: 'e3' }),
    ev('SubagentStart', { agent_type: 'researcher', agent_id: 'r1' }),
    ev('SubagentStop', { agent_type: 'engineer', agent_id: 'e2' }),
    ev('SubagentStart', { agent_type: 'engineer', agent_id: 'e1' }),
  ])
  assert.deepEqual(p?.roles.map(r => [r.id, r.role, r.state]), [['e2', 'engineer', 'done'], ['e3', 'engineer', 'active'], ['r1', 'researcher', 'active'], ['e1', 'engineer', 'active']])
  assert.equal(p?.roles.find(r => r.id === 'e3')?.startedAt, 1003)
})

test('roles: a stop with no agent id finishes the oldest running one of its role', () => {
  const p = run([ev('SessionStart'), ev('SubagentStart', { agent_type: 'qa', agent_id: 'q1' }), ev('SubagentStart', { agent_type: 'qa', agent_id: 'q2' }), ev('SubagentStop', { agent_type: 'qa' })])
  assert.deepEqual(p?.roles.map(r => [r.id, r.state]), [['q1', 'done'], ['q2', 'active']])
})

test('roles: Stop finishes every subagent but the ones still running in the background', () => {
  const p = run([ev('SessionStart'), ev('SubagentStart', { agent_type: 'qa', agent_id: 'q1' }), ev('SubagentStart', { agent_type: 'engineer', agent_id: 'e1' })])!
  const stopped = step({ ...p, running: ['q1'] }, ev('Stop'), 5000)
  assert.deepEqual(stopped?.roles.map(r => [r.id, r.state]), [['q1', 'active'], ['e1', 'done']])
})

test('Stop with background subagents still running stays working until the last one stops', () => {
  const p = run([ev('SessionStart'), ev('SubagentStart', { agent_type: 'qa', agent_id: 'q1' }), ev('SubagentStart', { agent_type: 'engineer', agent_id: 'e1' })])!
  const stopped = step(p, ev('Stop', { last_assistant_message: 'waiting on qa' }), 5000)!
  assert.equal(stopped.state, 'working')
  const one = step(stopped, ev('SubagentStop', { agent_type: 'qa', agent_id: 'q1' }), 6000)!
  assert.equal(one.state, 'working')
  assert.equal(step(one, ev('SubagentStop', { agent_type: 'engineer', agent_id: 'e1' }), 7000)!.state, 'idle')
})

test('a subagent stopping mid-turn leaves the chat working', () => {
  const p = run([ev('SessionStart'), ev('SubagentStart', { agent_type: 'qa', agent_id: 'q1' }), ev('SubagentStop', { agent_type: 'qa', agent_id: 'q1' })])!
  assert.equal(p.state, 'working')
})

test('roles: finished ones past the newest 12 are dropped, running ones always kept', () => {
  const starts = Array.from({ length: 20 }, (_, i) => ev('SubagentStart', { agent_type: 'engineer', agent_id: `e${i}` }))
  const stops = Array.from({ length: 18 }, (_, i) => ev('SubagentStop', { agent_type: 'engineer', agent_id: `e${i}` }))
  const p = run([ev('SessionStart'), ...starts, ...stops])
  assert.equal(p?.roles.length, 14)
  assert.deepEqual(p?.roles.filter(r => r.state === 'active').map(r => r.id), ['e18', 'e19'])
  assert.equal(p?.roles[0].id, 'e6')
})

test('tasks from TaskCreate and TaskUpdate, numbered like Claude Code', () => {
  const p = run([
    ev('SessionStart'),
    ev('PreToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'Find the loop' } }),
    ev('PreToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'Fix it' } }),
    ev('PreToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'completed', owner: 'researcher' } }),
  ])
  assert.deepEqual(p?.tasks, [
    { id: '1', subject: 'Find the loop', status: 'completed', role: 'researcher' },
    { id: '2', subject: 'Fix it', status: 'pending' },
  ])
})

test('tasks from TodoWrite replace the list', () => {
  const p = run([ev('SessionStart'), ev('PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }] } })])
  assert.deepEqual(p?.tasks.map(t => [t.subject, t.status]), [['A', 'completed'], ['B', 'in_progress']])
})

test('a question makes it needs-you; the next tool call clears it', () => {
  const asked = run([ev('SessionStart'), ev('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Keep Closet?' }] } })])
  assert.equal(asked?.state, 'needs-you')
  assert.equal(asked?.question, 'Keep Closet?')
  const after = step(asked, ev('PostToolUse', { tool_name: 'Read' }), 2000)
  assert.equal(after?.state, 'working')
  assert.equal(after?.question, undefined)
})

test('a permission prompt is needs-you; the idle reminder is not', () => {
  assert.equal(run([ev('SessionStart'), ev('Notification', { notification_type: 'permission_prompt', message: 'Allow Bash?' })])?.state, 'needs-you')
  assert.equal(run([ev('SessionStart'), ev('Notification', { notification_type: 'idle_prompt', message: 'waiting' })])?.state, 'working')
})

test('Stop with a commit message is done and keeps the message', () => {
  const msg = 'All checked.\n\nCommit message:\n```\nfix(login): stop the redirect loop\n\nCo-Authored-By: x\n```\n'
  const p = run([ev('SessionStart'), ev('Stop', { last_assistant_message: msg })])
  assert.equal(p?.state, 'done')
  assert.equal(p?.commit, 'fix(login): stop the redirect loop\n\nCo-Authored-By: x')
})

test('Stop with open tasks and no commit is idle; with every task done it is done', () => {
  const open = run([ev('SessionStart'), ev('PreToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'A' } }), ev('Stop', { last_assistant_message: 'paused' })])
  assert.equal(open?.state, 'idle')
  const closed = run([ev('SessionStart'), ev('PreToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'A' } }), ev('PreToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'completed' } }), ev('Stop', { last_assistant_message: 'ok' })])
  assert.equal(closed?.state, 'done')
})

test('Stop with no tasks and no commit is idle (a plain answer is not Done)', () => {
  assert.equal(run([ev('SessionStart'), ev('Stop', { last_assistant_message: 'Here you go.' })])?.state, 'idle')
})

test('SessionEnd removes the chat', () => {
  assert.equal(run([ev('SessionStart'), ev('SessionEnd')]), undefined)
})

test('an event for an unseen session starts it', () => {
  assert.equal(step(undefined, ev('PreToolUse', { tool_name: 'Read' }), 5)?.startedAt, 5)
})

test('commitMessage: heading variants, none when missing', () => {
  assert.equal(commitMessage('**Commit message:**\n```text\nfeat: x\n```'), 'feat: x')
  assert.equal(commitMessage('no block here'), undefined)
})

test('hub.hook keeps one row per chat and reports a change of state', () => {
  const h = new HubService()
  assert.equal(h.hook(ev('SessionStart'), 1), undefined)
  const t = h.hook(ev('Stop', { last_assistant_message: 'Commit message:\n```\nfeat: x\n```' }), 2)
  assert.equal(t?.from, 'working')
  assert.equal(t?.to.state, 'done')
  assert.equal(h.get().progress.length, 1)
  h.hook(ev('SessionEnd'), 3)
  assert.equal(h.get().progress.length, 0)
})

test('SessionStart from compact or resume keeps the chat; startup and clear reset it', () => {
  const made = run([ev('SessionStart', { source: 'startup' }), ev('SubagentStart', { agent_type: 'qa' }), ev('PreToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'A' } })])
  for (const source of ['compact', 'resume']) {
    const p = step(made, ev('SessionStart', { source }), 3000)
    assert.equal(p?.tasks.length, 1, source)
    assert.equal(p?.roles.length, 1, source)
  }
  for (const source of ['startup', 'clear']) assert.equal(step(made, ev('SessionStart', { source }), 3000)?.tasks.length, 0, source)
})

test('a background subagent updates roles and tasks but never the chat state, question or commit', () => {
  const msg = 'Commit message:\n```\nfeat: x\n```'
  const p = run([
    ev('SessionStart'),
    ev('SubagentStart', { agent_type: 'qa', agent_id: 'q1' }),
    ev('Stop', { last_assistant_message: msg }),
    ev('PreToolUse', { tool_name: 'Read', agent_id: 'q1' }),
    ev('PreToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'Check' }, agent_id: 'q1' }),
    ev('PostToolUse', { tool_name: 'Read', agent_id: 'q1' }),
    ev('UserPromptSubmit', { agent_id: 'q1' }),
    ev('SubagentStart', { agent_type: 'engineer', agent_id: 'e1' }),
    ev('SubagentStop', { agent_type: 'qa', agent_id: 'q1' }),
  ])
  assert.equal(p?.state, 'done')
  assert.equal(p?.commit, 'feat: x')
  assert.deepEqual(p?.tasks.map(t => t.subject), ['Check'])
  assert.deepEqual(p?.roles.map(r => [r.id, r.role, r.state]), [['q1', 'qa', 'done'], ['e1', 'engineer', 'active']])
})

test('an elicitation dialog is needs-you with its message', () => {
  const p = run([ev('SessionStart'), ev('Notification', { notification_type: 'elicitation_dialog', message: 'Pick a repo' })])
  assert.equal(p?.state, 'needs-you')
  assert.equal(p?.question, 'Pick a repo')
})

test('UserPromptSubmit sets working and clears the question, keeping the commit', () => {
  const done = run([ev('SessionStart'), ev('Stop', { last_assistant_message: 'Commit message:\n```\nfeat: x\n```' })])
  const p = step(done, ev('UserPromptSubmit', { prompt: 'more' }), 3000)
  assert.equal(p?.state, 'working')
  assert.equal(p?.commit, 'feat: x')
  const asked = run([ev('SessionStart'), ev('Notification', { notification_type: 'permission_prompt', message: 'Allow?' })])
  assert.equal(step(asked, ev('UserPromptSubmit'), 3000)?.question, undefined)
})

test('hub drops progress rows older than 24 hours', () => {
  const h = new HubService()
  h.hook({ ...ev('SessionStart'), session_id: 'old' }, 0)
  h.hook({ ...ev('SessionStart'), session_id: 'new' }, 24 * 60 * 60 * 1000 + 1)
  assert.deepEqual(h.get().progress.map(p => p.sessionId), ['new'])
})

test('a subagent waiting on a permission prompt makes the chat needs-you', () => {
  const p = run([ev('SessionStart'), ev('SubagentStart', { agent_type: 'engineer', agent_id: 'e1' }), ev('Notification', { notification_type: 'permission_prompt', message: 'Allow Bash?', agent_id: 'e1' })])
  assert.equal(p?.state, 'needs-you')
  assert.equal(p?.question, 'Allow Bash?')
})

test("a subagent's TodoWrite leaves the chat's task list alone", () => {
  const p = run([ev('SessionStart'), ev('PreToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'Main' } }), ev('PreToolUse', { tool_name: 'TodoWrite', agent_id: 'q2', tool_input: { todos: [{ content: 'sub', status: 'pending' }] } })])
  assert.deepEqual(p?.tasks.map(x => x.subject), ['Main'])
})

test('a follow-up after Done keeps the commit; a new block replaces it', () => {
  const block = (m: string) => ({ last_assistant_message: `Commit message:\n\`\`\`\n${m}\n\`\`\`` })
  const p = run([ev('SessionStart'), ev('Stop', block('feat: x')), ev('UserPromptSubmit', { prompt: 'why?' }), ev('PreToolUse', { tool_name: 'Read' }), ev('Stop', { last_assistant_message: 'Because.' })])
  assert.equal(p?.state, 'done')
  assert.equal(p?.commit, 'feat: x')
  assert.equal(step(p, { ...ev('Stop'), ...block('fix: y') }, 9000)?.commit, 'fix: y')
})

test('hub.hook ignores payloads with no cwd or cwd /', () => {
  const h = new HubService()
  assert.equal(h.hook({ ...ev('Stop', { last_assistant_message: 'Commit message:\n```\nfeat: x\n```' }), cwd: '/' }, 1), undefined)
  const { cwd: _cwd, ...bare } = ev('SessionStart')
  h.hook(bare, 2)
  assert.equal(h.get().progress.length, 0)
})

test('shouldNotify: done or needs-you once per same commit or question', () => {
  const done = run([ev('SessionStart'), ev('Stop', { last_assistant_message: 'Commit message:\n```\nfeat: x\n```' })])!
  assert.equal(shouldNotify(undefined, done), true)
  assert.equal(shouldNotify(notifyKey(done), done), false)
  assert.equal(shouldNotify(notifyKey(done), { ...done, commit: 'fix: y' }), true)
  assert.equal(shouldNotify(notifyKey(done), { ...done, state: 'needs-you', question: 'Keep?' }), true)
  assert.equal(shouldNotify(undefined, { ...done, state: 'idle' }), false)
})

test('canPrefill: only an empty box or the message Switchboard wrote last', () => {
  assert.equal(canPrefill('', undefined), true)
  assert.equal(canPrefill('feat: x', 'feat: x'), true)
  assert.equal(canPrefill('feat: x, edited', 'feat: x'), false)
  assert.equal(canPrefill('my own words', undefined), false)
})

test('plainText drops control characters osascript rejects', () => {
  assert.equal(plainText('a\u0000b\nc\u001fd\u007fe'), 'a b c d e')
})

test('notifyStep: a permission prompt asked again after the tool ran notifies again; a re-fired Done does not', async () => {
  const { HubService } = await import('../src/hub/hub-service')
  const hub = new HubService()
  let key: string | undefined
  const shown: string[] = []
  const fire = (payload: Record<string, unknown>) => {
    const c = hub.hook({ session_id: 's', cwd: '/r', ...payload })
    if (!c) return
    const n = notifyStep(key, c.to)
    key = n.key
    if (n.show) shown.push(c.to.state)
  }
  fire({ hook_event_name: 'SessionStart', source: 'startup' })
  const ask = { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }
  fire(ask); fire({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })
  fire(ask); fire({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })
  assert.deepEqual(shown, ['needs-you', 'needs-you'])
  const stop = { hook_event_name: 'Stop', last_assistant_message: 'Done.\n\nCommit message:\n```\nfix: x\n```' }
  fire(stop); fire({ hook_event_name: 'UserPromptSubmit' }); fire(stop)
  assert.deepEqual(shown, ['needs-you', 'needs-you', 'done'])
})

test('tools: lead and subagent calls, short targets, newest 8 kept', () => {
  const p = run([
    ev('SessionStart'),
    ev('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/Users/k/repo/src/hub/progress.ts' } }),
    ev('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'step(' }, agent_id: 'a1', agent_type: 'researcher' }),
    ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'cd extension && node_modules/.bin/tsx --test test/*.test.ts' } }),
    ev('PreToolUse', { tool_name: 'WebFetch', tool_input: { url: 'https://docs.example.com/a/b?q=1' } }),
    ev('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'engineer', prompt: 'secret long brief' } }),
    ev('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } }),
    ev('PreToolUse', { tool_name: 'TaskList', tool_input: {} }),
  ])
  assert.deepEqual(p?.tools?.map(t => [t.tool, t.target, t.role]), [
    ['Read', 'hub/progress.ts', 'lead'],
    ['Grep', 'step(', 'researcher'],
    ['Bash', 'cd extension && node_modules/.bin/tsx --', 'lead'],
    ['WebFetch', 'docs.example.com', 'lead'],
    ['Agent', 'engineer', 'lead'],
    ['Edit', 'a.ts', 'lead'],
    ['TaskList', undefined, 'lead'],
  ])
  assert.ok(!('target' in p!.tools![6]))
  const many = run([ev('SessionStart'), ...Array.from({ length: 10 }, (_, i) => ev('PreToolUse', { tool_name: `T${i}` }))])
  assert.deepEqual(many?.tools?.map(t => t.tool), ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'])
  assert.equal(run([ev('SessionStart'), ev('PreToolUse', { tool_name: 'Read' }), ev('SessionStart', { source: 'clear' })])?.tools, undefined)
})

test('running subagents are counted by id and outlive the chat\'s Stop', () => {
  const p = run([
    ev('SessionStart'),
    ev('SubagentStart', { agent_type: 'engineer', agent_id: 'e1' }),
    ev('SubagentStart', { agent_type: 'engineer', agent_id: 'e2' }),
    ev('Stop'),
    ev('SubagentStop', { agent_type: 'engineer', agent_id: 'e1' }),
  ])
  assert.deepEqual(p?.running, ['e2'])
  assert.deepEqual(step(p, ev('SessionStart', { source: 'clear' }), 9000)?.running, undefined)
})

test('background: the normal order still ends idle', () => {
  const p = run([ev('SessionStart'), ev('SubagentStart', { agent_type: 'qa', agent_id: 'q1' }), ev('Stop'), ev('SubagentStop', { agent_type: 'qa', agent_id: 'q1' })])
  assert.equal(p?.state, 'idle')
  assert.equal(p?.running, undefined)
  assert.equal(p?.waiting, undefined)
})

test('background: a stop with only the role clears the running id the role fallback hit', () => {
  const p = run([ev('SessionStart'), ev('SubagentStart', { agent_type: 'qa', agent_id: 'q1' }), ev('Stop'), ev('SubagentStop', { agent_type: 'qa' })])
  assert.equal(p?.running, undefined)
  assert.equal(p?.state, 'idle')
  assert.deepEqual(p?.roles.map(r => [r.id, r.state]), [['q1', 'done']])
})

const MIN = 60 * 1000
test('background: a stop with no id or role leaves it running until the 60 minute cap', () => {
  let p = step(undefined, ev('SessionStart'), 0)
  p = step(p, ev('SubagentStart', { agent_type: 'qa', agent_id: 'q1' }), 0)
  p = step(p, ev('Stop'), 1 * MIN)
  p = step(p, ev('SubagentStop', {}), 2 * MIN)
  assert.equal(p?.state, 'working')
  p = step(p, ev('UserPromptSubmit'), 61 * MIN)
  p = step(p, ev('Stop'), 61 * MIN)
  assert.equal(p?.state, 'idle')
  assert.equal(p?.running, undefined)
  assert.deepEqual(p?.roles.map(r => [r.id, r.state]), [['q1', 'done']])
})

test('background: one that never stops keeps the chat working only until the cap, across turns', () => {
  let p = step(undefined, ev('SessionStart'), 0)
  p = step(p, ev('SubagentStart', { agent_type: 'engineer', agent_id: 'e1' }), 0)
  const turn = (at: number) => { p = step(p, ev('UserPromptSubmit'), at); p = step(p, ev('Stop'), at + 1000) }
  turn(1 * MIN)
  assert.equal(p?.state, 'working')
  turn(30 * MIN)
  assert.equal(p?.state, 'working')
  assert.deepEqual(p?.running, ['e1'])
  turn(61 * MIN)
  assert.equal(p?.state, 'idle')
  assert.equal(p?.running, undefined)
})

test('background: compact keeps running and waiting; resume clears them (the old process is gone)', () => {
  const waiting = run([ev('SessionStart'), ev('SubagentStart', { agent_type: 'qa', agent_id: 'q1' }), ev('Stop')])!
  assert.equal(waiting.waiting, true)
  const compact = step(waiting, ev('SessionStart', { source: 'compact' }), 5000)!
  assert.deepEqual([compact.running, compact.waiting], [['q1'], true])
  const resume = step(waiting, ev('SessionStart', { source: 'resume' }), 5000)!
  assert.deepEqual([resume.running, resume.waiting, resume.roles.length], [undefined, undefined, 1])
  assert.equal(step(resume, ev('Stop'), 6000)?.state, 'idle')
})

test('a waiting chat quiet for an hour goes idle without another Stop', () => {
  const h = new HubService()
  h.hook(ev('SessionStart'), 0)
  h.hook(ev('SubagentStart', { agent_type: 'qa', agent_id: 'q1' }), 1)
  h.hook(ev('Stop'), 2)
  h.set({}, 30 * 60e3)
  assert.equal(h.get().progress[0].state, 'working')
  h.set({}, 61 * 60e3)
  const p = h.get().progress[0]
  assert.equal(p.state, 'idle')
  assert.equal(p.waiting, undefined)
  assert.equal(p.running, undefined)
})
