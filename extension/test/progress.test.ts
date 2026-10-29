import { test } from 'node:test'
import assert from 'node:assert/strict'
import { step, settle, finishedJobs, RUNNING_CAP_MS, commitMessage, shouldNotify, notifyKey, notifyStep, canPrefill, plainText, askKeys, dropAsk, askedQuestion, standup, doneText, almostDone, missed, todayText, newerVersion } from '../src/hub/progress'
import { coverageItems, parseScores } from '../src/hub/coverage'
import { commandProblem } from '../src/hub/routes'
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
    { id: '1', subject: 'Find the loop', status: 'completed', role: 'researcher', startedAt: 1003, doneAt: 1003 },
    { id: '2', subject: 'Fix it', status: 'pending' },
  ])
})

test('task times: start on in progress, finish on completed, kept through a TodoWrite rewrite', () => {
  const todo = (b: string) => ev('PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: b }] } })
  const p = run([ev('SessionStart'), ev('PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] } }), todo('pending'), todo('in_progress'), todo('completed')])!
  assert.deepEqual(p.tasks.map(t => [t.subject, t.startedAt, t.doneAt]), [['A', 1001, 1002], ['B', 1003, 1004]])
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

test('askedQuestion: the last paragraph ending in ? is a question, a trailing fence ignored', () => {
  assert.equal(askedQuestion('Fixed the build.\n\nShould I also bump the version? It is 1.2 now, so 1.3?'), 'It is 1.2 now, so 1.3?')
  assert.equal(askedQuestion('Which one?\n\n```\nnpm test\n```\n'), 'Which one?')
  assert.equal(askedQuestion('Is this ok?\n\nDone.'), undefined)
  assert.equal(askedQuestion('Change:\n\n```diff\n-a\n+b\n```\n\nApply it to main too?\n\n```bash\ngit apply x\n```'), 'Apply it to main too?')
  assert.equal(askedQuestion('Here you go.'), undefined)
  assert.equal(askedQuestion(''), undefined)
  assert.equal(askedQuestion(`${'x'.repeat(400)}?`)!.length <= 300, true)
})

// Same table as claude-mods usage-meter/tests/usage-meter.test.ts (endsAsking); keep the two in step.
const ENDS_ASKING: [string, boolean][] = [
  ['Which one?\n\n```\nnpm test\n```\n', true],
  ['Change:\n\n```diff\n-a\n+b\n```\n\nApply it to main too?\n\n```bash\ngit apply x\n```', true],
  ['Should I bump the version? I left it at 1.2 for now.', false],
  ['Is this ok?\n\nDone.', false],
  ['Fixed the build. Tests pass. Should I also bump the version?', true],
  ['Here you go.', false],
  ['', false],
]

test('askedQuestion: the shared ends-on-a-question table', () => {
  for (const [text, asks] of ENDS_ASKING) assert.equal(!!askedQuestion(text), asks, JSON.stringify(text))
})

test('Stop ending on a question needs Kenneth; his next prompt or the next tool call clears it', () => {
  const asked = run([ev('SessionStart'), ev('Stop', { last_assistant_message: 'Two ways to go.\n\nWant the cache or the index?' })])!
  assert.equal(asked.state, 'needs-you')
  assert.equal(asked.question, 'Want the cache or the index?')
  assert.equal(asked.ask, undefined)
  assert.equal(shouldNotify(undefined, asked), true)
  for (const next of [ev('UserPromptSubmit', { prompt: 'index' }), ev('PreToolUse', { tool_name: 'Read' })]) {
    const p = step(asked, next, 9000)!
    assert.equal(p.state, 'working')
    assert.equal(p.question, undefined)
  }
})

test('Stop asking a question while a subagent runs stays working; with a commit block it is done', () => {
  const bg = run([ev('SessionStart'), ev('SubagentStart', { agent_type: 'qa', agent_id: 'q1' }), ev('Stop', { last_assistant_message: 'Ok?' })])
  assert.equal(bg?.state, 'working')
  const done = run([ev('SessionStart'), ev('Stop', { last_assistant_message: 'Any more?\n\nCommit message:\n```\nfeat: x\n```' })])
  assert.equal(done?.state, 'done')
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

test('a mirrored hook updates progress but reports no change, so only the owning window notifies', () => {
  const h = new HubService()
  h.hook(ev('SessionStart'), 1, true)
  assert.equal(h.hook(ev('Stop', { last_assistant_message: 'Commit message:\n```\nfeat: x\n```' }), 2, true), undefined)
  assert.equal(h.get().progress[0]?.state, 'done')
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

test('a background subagent updates roles and tasks but never the chat question or commit', () => {
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
  // e1 still runs, so the block only marks it wrapping up.
  assert.equal(p?.state, 'working')
  assert.equal(p?.waiting, true)
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

test('a follow-up after Done keeps the commit for Copy but is not Done itself; a new block replaces it', () => {
  const block = (m: string) => ({ last_assistant_message: `Commit message:\n\`\`\`\n${m}\n\`\`\`` })
  const p = run([ev('SessionStart'), ev('Stop', block('feat: x')), ev('UserPromptSubmit', { prompt: 'why?' }), ev('PreToolUse', { tool_name: 'Read' }), ev('Stop', { last_assistant_message: 'Because.' })])
  assert.equal(p?.state, 'idle')
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

// Recorded from claude 2.1.312, trimmed.
const PERM = {
  hook_event_name: 'PermissionRequest', permission_mode: 'default', tool_name: 'Bash',
  tool_input: { command: 'git init', description: 'Initialize a git repository' },
  permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git init *' }], behavior: 'allow', destination: 'localSettings' }],
}
const ASK_INPUT = { questions: [{ header: 'Color', question: 'Which color?', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }] }

test('ask: a permission prompt carries the tool, what it runs and the terminal options in order', () => {
  const p = run([ev('SessionStart'), ev('PreToolUse', { tool_name: 'Bash', tool_input: PERM.tool_input }), ev('PermissionRequest', PERM)])!
  assert.equal(p.state, 'needs-you')
  assert.deepEqual({ ...p.ask, id: undefined }, { id: undefined, kind: 'permission', tool: 'Bash', preview: 'git init', options: ['Yes', "Yes, and don't ask again for: git init *", 'No'] })
  const dir = step(p, ev('PermissionRequest', { ...PERM, tool_input: { command: 'touch b.txt' }, permission_suggestions: [{ type: 'addDirectories', directories: ['/tmp/keytest'] }, { type: 'setMode', mode: 'acceptEdits' }] }), 9)!
  assert.deepEqual(dir.asks?.[1].options, ['Yes', 'Yes, and always allow access to keytest/ from this project', 'No'])
  assert.deepEqual(step(p, ev('PermissionRequest', { ...PERM, permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits' }] }), 9)?.asks?.[1].options, ['Yes', 'No'])
  assert.notEqual(dir.asks?.[1].id, p.ask?.id)
  // The Notification after it keeps the text, so it notifies once.
  assert.equal(step(p, ev('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' }), 9)?.question, p.question)
})

test('ask: the preview is cut to 300 characters with control characters gone', () => {
  const p = run([ev('SessionStart'), ev('PermissionRequest', { ...PERM, tool_input: { command: `echo\u0007${'x'.repeat(400)}` } })])!
  assert.equal(p.ask?.preview?.length, 300)
  assert.ok(!p.ask?.preview?.includes('\u0007'))
})

test('ask: cleared where the question is, and by the end of the subagent call it was for', () => {
  const p = run([ev('SessionStart'), ev('PermissionRequest', PERM)])!
  for (const e of [ev('PostToolUse', { tool_name: 'Bash', tool_input: PERM.tool_input }), ev('UserPromptSubmit'), ev('Stop'), ev('PreToolUse', { tool_name: 'Read' })]) assert.equal(step(p, e, 9)?.ask, undefined, e.hook_event_name)
  const sub = step(undefined, ev('PermissionRequest', { ...PERM, agent_id: 'a1' }), 1)!
  assert.ok(step(sub, ev('PostToolUse', { agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'ls' } }), 2)?.ask)
  const done = step(sub, ev('PostToolUse', { agent_id: 'a1', tool_name: 'Bash', tool_input: PERM.tool_input }), 2)!
  assert.deepEqual([done.ask, done.state], [undefined, 'working'])
})

test('ask: parallel prompts queue oldest first, each leaving when its own call ends', () => {
  const ls = { command: 'ls' }, pwd = { command: 'pwd' }
  const p = run([ev('SessionStart'), ev('PermissionRequest', { ...PERM, agent_id: 'a1', tool_input: ls }), ev('PermissionRequest', { ...PERM, agent_id: 'a2', tool_input: pwd })])!
  assert.equal(p.ask?.preview, 'ls')
  assert.equal(p.asks?.length, 2)
  // The lead working on, or another call ending, leaves both.
  assert.equal(step(p, ev('PreToolUse', { tool_name: 'Read', tool_input: {} }), 9)?.ask?.preview, 'ls')
  assert.equal(step(p, ev('PostToolUse', { tool_name: 'Read', tool_input: {} }), 9)?.ask?.preview, 'ls')
  const one = step(p, ev('PostToolUseFailure', { agent_id: 'a1', tool_name: 'Bash', tool_input: ls }), 9)!
  assert.deepEqual([one.ask?.preview, one.asks?.length, one.state], ['pwd', 1, 'needs-you'])
  const none = step(one, ev('PostToolUse', { agent_id: 'a2', tool_name: 'Bash', tool_input: pwd }), 10)!
  assert.deepEqual([none.ask, none.asks, none.state], [undefined, undefined, 'working'])
  assert.equal(step(p, ev('Stop'), 9)?.asks, undefined)
  // Answered from Switchboard: that one goes, the next shows.
  assert.equal(dropAsk(p, p.ask!.id).ask?.preview, 'pwd')
  assert.equal(dropAsk(p, 'gone').ask?.preview, 'ls')
})

test('ask: a question ask ends with its own call', () => {
  const p = run([ev('SessionStart'), ev('PermissionRequest', { ...PERM, agent_id: 'a1' }), ev('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_q', tool_input: ASK_INPUT })])!
  assert.deepEqual(p.asks?.map(a => a.kind), ['permission', 'question'])
  const left = step(p, ev('PostToolUse', { agent_id: 'a1', tool_name: 'Bash', tool_input: PERM.tool_input }), 9)!
  assert.deepEqual([left.ask?.id, left.question], ['toolu_q', 'Which color?'])
  assert.equal(step(left, ev('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_q', tool_input: ASK_INPUT }), 10)?.ask, undefined)
})

test('ask: one unreadable question drops the buttons for the whole ask', () => {
  const q = ASK_INPUT.questions[0]
  const p = run([ev('SessionStart'), ev('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 't9', tool_input: { questions: [q, { question: 'Size?', options: [] }] } })])!
  assert.deepEqual([p.state, p.ask], ['needs-you', undefined])
})

test('ask: tools with their own dialog get no permission buttons', () => {
  const p = run([ev('SessionStart'), ev('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_1', tool_input: ASK_INPUT }), ev('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: ASK_INPUT })])!
  assert.deepEqual(p.ask, { id: 'toolu_1', kind: 'question', tool: 'AskUserQuestion', options: [], questions: [{ header: 'Color', question: 'Which color?', options: ['Red', 'Blue'] }] })
  assert.equal(step(undefined, ev('PermissionRequest', { tool_name: 'ExitPlanMode', tool_input: {} }), 1)?.ask, undefined)
})

test('askKeys: permission options as the terminal takes them', () => {
  const p = run([ev('SessionStart'), ev('PermissionRequest', PERM)])!.ask!
  assert.deepEqual(askKeys(p, [0]), ['1'])
  assert.deepEqual(askKeys(p, [1]), ['2'])
  assert.deepEqual(askKeys(p, [2]), ['\x1b'])
  assert.equal(typeof askKeys(p, [3]), 'string')
  assert.equal(typeof askKeys(p, [0, 1]), 'string')
})

test('hub-answer: one option index per question', () => {
  assert.equal(commandProblem({ type: 'hub-answer', sessionId: 's', askId: 'a', choice: [0] }), undefined)
  for (const choice of [[], [-1], [1.5], ['1'], [0, 0, 0, 0, 0], 0]) assert.match(commandProblem({ type: 'hub-answer', sessionId: 's', askId: 'a', choice }) ?? '', /choice/)
})

test('askKeys: questions take one number each, and several end on Submit', () => {
  const one = run([ev('SessionStart'), ev('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 't1', tool_input: ASK_INPUT })])!.ask!
  assert.deepEqual(askKeys(one, [1]), ['2'])
  const q = ASK_INPUT.questions[0]
  const two = run([ev('SessionStart'), ev('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 't2', tool_input: { questions: [q, { ...q, question: 'Size?' }] } })])!.ask!
  assert.deepEqual(askKeys(two, [1, 0]), ['2', '1', '1'])
  assert.equal(typeof askKeys(two, [0]), 'string')
  assert.equal(typeof askKeys(two, [0, 2]), 'string')
  const multi = run([ev('SessionStart'), ev('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 't3', tool_input: { questions: [{ ...q, multiSelect: true }] } })])!.ask!
  assert.match(String(askKeys(multi, [0])), /terminal/)
})

const COMMIT = { last_assistant_message: 'All set.\n\nCommit message:\n```\nfix: x\n```' }

test('finish: a commit block with a background subagent running stays wrapping up past its SubagentStop; the lead\'s next Stop decides', () => {
  const p = run([ev('SessionStart'), ev('SubagentStart', { agent_type: 'engineer', agent_id: 'e1' }), ev('Stop', COMMIT)])!
  assert.equal(p.state, 'working')
  assert.equal(p.waiting, true)
  assert.equal(p.commit, 'fix: x')
  assert.equal(p.finishedAt, undefined)
  const after = step(p, ev('SubagentStop', { agent_type: 'engineer', agent_id: 'e1' }), 9000)!
  assert.deepEqual([after.state, after.waiting, after.running, after.finishedAt], ['working', true, undefined, undefined])
  // The lead answers the notification: its own message decides.
  const done = step(after, ev('Stop', COMMIT), 9500)!
  assert.deepEqual([done.state, done.finishedAt, done.waiting], ['done', 9500, undefined])
  assert.equal(step(after, ev('Stop', { last_assistant_message: 'Engineer is back, one more fix needed.' }), 9500)!.state, 'idle')
})

test('finish: wrapping up with nothing left running and no lead Stop settles idle at the cap', () => {
  const p = run([ev('SessionStart'), ev('SubagentStart', { agent_type: 'engineer', agent_id: 'e1' }), ev('Stop', COMMIT), ev('SubagentStop', { agent_type: 'engineer', agent_id: 'e1' })])!
  assert.equal(settle(p, p.at + 1000).state, 'working')
  assert.equal(settle(p, p.at + RUNNING_CAP_MS).state, 'idle')
})

test('finish: no block this turn, the last subagent stopping is idle, not Done', () => {
  const p = run([ev('SessionStart'), ev('Stop', COMMIT), ev('UserPromptSubmit'), ev('SubagentStart', { agent_type: 'qa', agent_id: 'q1' }), ev('Stop', { last_assistant_message: 'qa is checking' })])!
  assert.equal(p.state, 'working')
  assert.equal(step(p, ev('SubagentStop', { agent_type: 'qa', agent_id: 'q1' }), 9000)!.state, 'idle')
})

test('finish: an old commit block carried into a new Stop with no block is not Done', () => {
  const p = run([ev('SessionStart'), ev('Stop', COMMIT), ev('UserPromptSubmit'), ev('Stop', { last_assistant_message: 'Answered.' })])!
  assert.equal(p.state, 'idle')
  assert.equal(p.commit, 'fix: x')
})

test('finish: open tasks with a commit block is idle', () => {
  const p = run([ev('SessionStart'), ev('PreToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'A' } }), ev('PreToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'B' } }), ev('PreToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'completed' } }), ev('Stop', COMMIT)])!
  assert.equal(p.state, 'idle')
  assert.equal(p.tasks.filter(t => t.status !== 'completed').length, 1)
})

// Recorded from claude 2.1.312, trimmed: a Bash with run_in_background, then its task-notification in the transcript.
const BG_POST = {
  hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_01AoVrFSc66BD5YHtMHRjmbx',
  tool_input: { command: 'until ...; do sleep 2; done', description: 'Wait until both windows reload onto the new version', run_in_background: true },
  tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'bo727da6e' },
}
const NOTE = '{"type":"queue-operation","operation":"enqueue","content":"<task-notification>\\n<task-id>bo727da6e</task-id>\\n<tool-use-id>toolu_01AoVrFSc66BD5YHtMHRjmbx</tool-use-id>\\n<output-file>/tmp/x.output</output-file>\\n<status>completed</status>\\n<summary>Background command done</summary>\\n</task-notification>"}'

test('finishedJobs: tool use ids of task notifications with an end status', () => {
  const killed = NOTE.replace('toolu_01AoVrFSc66BD5YHtMHRjmbx', 'toolu_k').replace('completed', 'killed')
  const update = NOTE.replace('toolu_01AoVrFSc66BD5YHtMHRjmbx', 'toolu_m').replace('<status>completed</status>', '<event>line</event>')
  assert.deepEqual(finishedJobs([NOTE, killed, update].join('\n')), ['toolu_01AoVrFSc66BD5YHtMHRjmbx', 'toolu_k'])
})

test('jobs: a background Bash keeps the chat wrapping up until its notification, then Done', () => {
  const p = run([ev('SessionStart'), ev('PostToolUse', BG_POST), ev('Stop', COMMIT)])!
  assert.deepEqual(p.jobs, [{ id: 'toolu_01AoVrFSc66BD5YHtMHRjmbx', label: 'Wait until both windows reload onto the new version', task: 'bo727da6e', startedAt: 1001 }])
  assert.equal(p.state, 'working')
  assert.equal(p.waiting, true)
  // The notification starts a lead turn; its Stop carries what the transcript says finished.
  const done = step(p, ev('Stop', { ...COMMIT, bg_finished: ['toolu_01AoVrFSc66BD5YHtMHRjmbx'] }), 9000)!
  assert.equal(done.state, 'done')
  assert.equal(done.jobs, undefined)
  assert.equal(done.finishedAt, 9000)
})

test('jobs: a Monitor counts; a foreground Bash and a subagent\'s background Bash do not', () => {
  const p = run([
    ev('SessionStart'),
    ev('PostToolUse', { tool_name: 'Monitor', tool_use_id: 't1', tool_input: { command: 'tail -f x', description: 'watch the log' }, tool_response: {} }),
    ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'ls' }, tool_response: { stdout: 'a' } }),
    ev('PostToolUse', { ...BG_POST, tool_use_id: 't3', agent_id: 'e1' }),
  ])!
  assert.deepEqual(p.jobs?.map(j => [j.id, j.label]), [['t1', 'watch the log']])
})

test('jobs: one with no notification drops at the cap', () => {
  let p = step(undefined, ev('SessionStart'), 0)
  p = step(p, { ...ev('PostToolUse', BG_POST) }, 0)
  p = step(p, ev('Stop', COMMIT), 1000)
  assert.equal(p?.state, 'working')
  p = step(p, ev('UserPromptSubmit'), RUNNING_CAP_MS + 1)
  p = step(p, ev('Stop', COMMIT), RUNNING_CAP_MS + 2)
  assert.equal(p?.state, 'done')
  assert.equal(p?.jobs, undefined)
})

test('jobs: settle drops jobs too, and a resume clears them', () => {
  const p = run([ev('SessionStart'), ev('PostToolUse', BG_POST), ev('Stop', COMMIT)])!
  const s = settle(p, 1002 + RUNNING_CAP_MS)
  assert.deepEqual([s.state, s.jobs, s.waiting], ['idle', undefined, undefined])
  assert.equal(step(p, ev('SessionStart', { source: 'resume' }), 5000)?.jobs, undefined)
})

test('hub.hook reads finished jobs from the transcript on Stop', async () => {
  const fs = await import('fs'), os = await import('os'), path = await import('path')
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')), 't.jsonl')
  fs.writeFileSync(file, '')
  const h = new HubService()
  h.hook(ev('SessionStart'), 1)
  h.hook(ev('PostToolUse', BG_POST), 2)
  h.hook(ev('Stop', { ...COMMIT, transcript_path: file }), 3)
  assert.equal(h.get().progress[0].state, 'working')
  fs.writeFileSync(file, NOTE + '\n')
  const c = h.hook(ev('Stop', { ...COMMIT, transcript_path: file }), 4)
  assert.equal(c?.to.state, 'done')
})

test('notify: Done shows once on the real transition, not while wrapping up', () => {
  const p = run([ev('SessionStart'), ev('SubagentStart', { agent_type: 'engineer', agent_id: 'e1' }), ev('Stop', COMMIT)])!
  assert.equal(notifyStep(undefined, p).show, false)
  const back = step(p, ev('SubagentStop', { agent_type: 'engineer', agent_id: 'e1' }), 9000)!
  assert.equal(notifyStep(undefined, back).show, false)
  const done = step(back, ev('Stop', COMMIT), 9500)!
  const n = notifyStep(undefined, done)
  assert.equal(n.show, true)
  assert.equal(notifyStep(n.key, step(done, ev('Notification', { notification_type: 'idle_prompt' }), 9500)!).show, false)
})

// Recorded from claude 2.1.312 (Armasu 34d9633a): a TaskStop on a background subagent sends no SubagentStop.
test('roles: the lead stopping a subagent with TaskStop ends it', () => {
  const stop = { tool_name: 'TaskStop', tool_input: { task_id: 'a411c83c8fda46cd7' }, tool_response: { message: 'Successfully stopped task: a411c83c8fda46cd7 (Fix remaining risks and browser QA)', task_id: 'a411c83c8fda46cd7' } }
  const p = run([ev('SessionStart'), ev('SubagentStart', { agent_type: 'engineer', agent_id: 'a411c83c8fda46cd7' }), ev('SubagentStart', { agent_type: 'qa', agent_id: 'q1' }), ev('PostToolUse', stop)])!
  assert.deepEqual(p.running, ['q1'])
  assert.deepEqual(p.roles.map(r => [r.id, r.state]), [['a411c83c8fda46cd7', 'done'], ['q1', 'active']])
  // A failed stop or a subagent's own TaskStop leaves it running.
  const q = run([ev('SessionStart'), ev('SubagentStart', { agent_type: 'engineer', agent_id: 'e1' }), ev('PostToolUseFailure', { ...stop, tool_input: { task_id: 'e1' } }), ev('PostToolUse', { ...stop, tool_input: { task_id: 'e1' }, agent_id: 'q1' })])!
  assert.deepEqual(q.running, ['e1'])
})

// Recorded from claude 2.1.312: TaskStop names a shell by its backgroundTaskId, and a stopped shell writes no notification.
test('jobs: the lead stopping a background Bash with TaskStop ends it', () => {
  const stop = { tool_name: 'TaskStop', tool_input: { task_id: 'bo727da6e' }, tool_response: { message: 'Successfully stopped task: bo727da6e (until ...)', task_id: 'bo727da6e', task_type: 'local_bash' } }
  const p = run([ev('SessionStart'), ev('PostToolUse', BG_POST), ev('PostToolUse', stop), ev('Stop', COMMIT)])!
  assert.equal(p.jobs, undefined)
  assert.equal(p.state, 'done')
})

const LIMIT = { error: 'rate_limit', error_details: '429 Too Many Requests', last_assistant_message: 'API Error: Rate limit reached' }

test('StopFailure on a usage limit ends the turn on needs-you, marked limited', () => {
  const p = run([ev('SessionStart'), ev('SubagentStart', { agent_type: 'qa', agent_id: 'q1' }), ev('PermissionRequest', PERM), ev('StopFailure', LIMIT)])!
  assert.equal(p.state, 'needs-you')
  assert.match(p.question!, /Usage limit hit\. It continues by itself after the limit resets\./)
  assert.deepEqual(p.limited, { at: 1003, error: 'rate_limit' })
  assert.equal(p.ask, undefined)
  assert.equal(p.roles[0].state, 'active', 'a background subagent still runs')
})

test('StopFailure on another API error says which, and a subagent one changes nothing', () => {
  const p = run([ev('SessionStart'), ev('StopFailure', { error: 'server_error', last_assistant_message: 'API Error: 500' })])!
  assert.equal(p.question, 'API error (server_error): API Error: 500')
  assert.equal(p.limited, undefined)
  const s = run([ev('SessionStart'), ev('StopFailure', { ...LIMIT, agent_id: 'a1' })])!
  assert.equal(s.state, 'working')
  assert.equal(s.limited, undefined)
})

test('limited stays through a prompt that fails again; real progress clears it', () => {
  const hit = run([ev('SessionStart'), ev('StopFailure', LIMIT)])!
  const sent = step(hit, ev('UserPromptSubmit'), 2000)!
  assert.equal(sent.state, 'needs-you')
  assert.ok(sent.limited)
  assert.equal(step(sent, ev('StopFailure', LIMIT), 2001)!.state, 'needs-you')
  assert.equal(step(sent, ev('PreToolUse', { tool_name: 'Read', tool_input: {} }), 2001)!.limited, undefined)
  assert.equal(step(sent, ev('Stop', { last_assistant_message: 'ok' }), 2001)!.limited, undefined)
})

test('notifyStep: a limit warns once while it lasts, and again after recovery', () => {
  let key: string | undefined
  const shown: number[] = []
  let p: ReturnType<typeof step>
  const fire = (e: Record<string, unknown>, at: number) => { p = step(p, e, at); const n = notifyStep(key, p!); key = n.key; if (n.show) shown.push(at) }
  fire(ev('SessionStart'), 1)
  fire(ev('StopFailure', LIMIT), 2)
  fire(ev('UserPromptSubmit'), 3)
  fire(ev('StopFailure', LIMIT), 4)
  fire(ev('UserPromptSubmit'), 5)
  fire(ev('PreToolUse', { tool_name: 'Read', tool_input: {} }), 6)
  fire(ev('StopFailure', LIMIT), 7)
  assert.deepEqual(shown, [2, 7])
})

const STANDUP = 'Fixed it.\n\n**Done**\n- Wrote the **failing** test\n- Fixed the parser\n\n**Left**\n1. Ship the vsix\n2) Update docs\n\n**Risks**\n- none\n\nCommit message:\n```\nfix: x\n```'

test('standup: Done and Left items from bold lines, headings or labels; an empty Left is none', () => {
  assert.deepEqual(standup(STANDUP), { done: ['Wrote the failing test', 'Fixed the parser'], left: ['Ship the vsix', 'Update docs'] })
  assert.deepEqual(standup('## Done\n- A\n* B\n\n## Left\n- Nothing.\n\n## Risks\n- C'), { done: ['A', 'B'], left: [] })
  assert.deepEqual(standup('Done:\n- A\nLeft: none\nRisks: none'), { done: ['A'], left: [] })
  assert.deepEqual(standup('**Done:** the build\n**Left:** no open items'), { done: ['the build'], left: [] })
  assert.deepEqual(standup('Left:\n- Ship it\n\nCommit message:\n```\nfix\n```'), { done: [], left: ['Ship it'] })
  assert.equal(standup('Done fixing it. Left the docs alone.'), undefined)
  assert.equal(standup(''), undefined)
  const many = standup(`**Done**\n${Array.from({ length: 20 }, () => `- ${'x'.repeat(300)}`).join('\n')}`)!
  assert.equal(many.done.length, 12)
  assert.equal(many.done[0].length <= 160, true)
})

test('Stop keeps the standup: Left items make a done chat almost done, with its own notify key and text', () => {
  const tasks = [ev('PreToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'a' } }), ev('PreToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'completed' } })]
  const almost = run([ev('SessionStart'), ...tasks, ev('Stop', { last_assistant_message: STANDUP })])!
  assert.equal(almost.state, 'done')
  assert.deepEqual(almost.report?.left, ['Ship the vsix', 'Update docs'])
  const done = run([ev('SessionStart'), ...tasks, ev('Stop', { last_assistant_message: STANDUP.replace(/\*\*Left\*\*\n1\. Ship the vsix\n2\) Update docs/, '**Left**\n- none') })])!
  assert.deepEqual(done.report?.left, [])
  assert.notEqual(notifyKey(almost), notifyKey(done))
  assert.equal(shouldNotify(notifyKey(almost), done), true)
  assert.equal(doneText(almost), 'almost done, 2 left: Ship the vsix')
  assert.equal(doneText(done), 'finished, all 1 task done')
  assert.equal(doneText({ ...done, tasks: [] }), 'finished')
  assert.equal(run([ev('SessionStart'), ...tasks, ev('Stop', { last_assistant_message: 'Done.' })])!.report, undefined)
})

test('Stop: a standup with Done items finishes a chat that had nothing to commit; prose alone stays idle', () => {
  const said = (m: string) => run([ev('SessionStart'), ev('Stop', { last_assistant_message: m })])!
  assert.equal(said('Nothing to change.\n\n**Standup**\n- **Done:** checked the README\n- **Left:** nothing.').state, 'done')
  assert.equal(almostDone(said('**Done:** looked\n**Left:** reload VS Code')), true)
  assert.equal(said('I looked at it.').state, 'idle')
  assert.equal(said('**Left:** reload VS Code').state, 'idle')
})

test('asked: Kenneth\'s own prompts, newest 8, cut short; not mod, notification, reminder or subagent ones; reset on a new chat only', () => {
  const say = (prompt: string, extra = {}) => ev('UserPromptSubmit', { prompt, ...extra })
  const p = run([
    ev('SessionStart'), say('fix the login'), say('Switchboard: the usage limit reset.'), say('<task-notification>x</task-notification>'),
    say('<system-reminder>only this</system-reminder>\n'), say('sub work', { agent_id: 'a1' }), say(`${'y'.repeat(300)}`),
  ])!
  assert.deepEqual(p.asked?.map(a => a.slice(0, 12)), ['fix the logi', 'yyyyyyyyyyyy'])
  assert.equal(p.asked![1].length, 200)
  const lots = run([ev('SessionStart'), ...Array.from({ length: 10 }, (_, i) => say(`ask ${i}`))])!
  assert.deepEqual(lots.asked, ['ask 2', 'ask 3', 'ask 4', 'ask 5', 'ask 6', 'ask 7', 'ask 8', 'ask 9'])
  assert.deepEqual(step(p, ev('SessionStart', { source: 'compact' }), 9000)?.asked, p.asked)
  assert.equal(step(p, ev('SessionStart', { source: 'clear' }), 9000)?.asked, undefined)
})

test('standup: sub-headings, prose openers, real "Nothing" items, wrapped bullets', () => {
  const msg = [
    '**Done**', '- A', '1. B', '', '**Left**', '- C wraps', '  onto a second line', '', '**Left (needs you)**', '- D',
    '**Left for you:**', '- E', '', '**Risks**', '- R', '', 'Commit message:', '```', '- not an item', '```',
  ].join('\n')
  assert.deepEqual(standup(msg), { done: ['A', 'B'], left: ['C wraps onto a second line', 'D', 'E'] })
  assert.equal(standup('**Done.** The retries now survive a reload.'), undefined)
  assert.deepEqual(standup('**Left**\n- Nothing blocks shipping, but the legend needs teal')?.left, ['Nothing blocks shipping, but the legend needs teal'])
  assert.deepEqual(standup('**Done**\n- A\n\n**Left**\n- None.')?.left, [])
  assert.deepEqual(standup('Done: shipped it\nLeft: none'), { done: ['shipped it'], left: [] })
  assert.deepEqual(standup('**Left:** reload VS Code'), { done: [], left: ['reload VS Code'] })
  assert.deepEqual(standup('**Standup**\n- **Done:** checked it\n- **Left:** nothing.\n- **Risks:** none'), { done: ['checked it'], left: [] })
  assert.deepEqual(standup('**Open questions**\n- Should we X?')?.left, ['Should we X?'])
})

test('coverage: a request Jev scores as not covered keeps a done chat almost done and says so', () => {
  const done = run([ev('SessionStart'), ev('UserPromptSubmit', { prompt: 'reload both windows' }), ev('UserPromptSubmit', { prompt: 'add a Today push' }),
    ev('Stop', { last_assistant_message: '**Done**\n- Reloaded both windows\n\nCommit message:\n```\nx\n```' })])!
  assert.equal(done.state, 'done')
  assert.equal(almostDone(done), false)
  const scored = step(done, ev('SwitchboardCovered', { scores: [0.94, 0.09] }), 5)!
  assert.deepEqual(missed(scored), ['add a Today push'])
  assert.equal(almostDone(scored), true)
  assert.match(doneText(scored), /1 of your requests not covered: add a Today push/)
  assert.notEqual(notifyKey(scored), notifyKey(done))
  assert.equal(almostDone(step(done, ev('SwitchboardCovered', { scores: [0.94, null] }), 5)!), false)
  assert.equal(step(scored, ev('Stop', { last_assistant_message: 'ok' }), 6)!.covered, undefined)
})

test('coverage: jev.py lines map back to requests by _id', () => {
  const out = '[jev] 2 items\n{"_id": "1", "addressed": 0.09}\n{"_id": "0", "addressed": 0.94}\n{"_id": "9", "addressed": 1}\nnoise'
  assert.deepEqual(parseScores(out, 3), [0.94, 0.09, null])
  const p = run([ev('SessionStart'), ev('UserPromptSubmit', { prompt: 'a' }), ev('Stop', { last_assistant_message: '**Done**\n- x\n- y\n\n**Left**\n- z' })])!
  assert.deepEqual(coverageItems(p), [{ _id: '0', request: 'a', done: 'x\ny', left: 'z' }])
})

test('todayText: finished, almost done and needs-you chats from today; quiet days say nothing', () => {
  const now = new Date(2026, 9, 29, 18, 30).getTime(), today = now - 3600_000, yday = now - 26 * 3600_000
  const base = { cwd: '/r', roles: [], tasks: [], startedAt: 0 }
  const all = [
    { ...base, sessionId: 'a', state: 'done' as const, at: today, finishedAt: today },
    { ...base, sessionId: 'b', state: 'done' as const, at: today, finishedAt: today, report: { done: [], left: ['x'] } },
    { ...base, sessionId: 'c', state: 'needs-you' as const, at: today },
    { ...base, sessionId: 'd', state: 'done' as const, at: yday, finishedAt: yday },
  ]
  assert.equal(todayText(all, p => p.sessionId, now), '1 finished; 1 almost done: b; 1 need you: c')
  assert.equal(todayText(all.slice(3), p => p.sessionId, now), undefined)
})

test('newerVersion compares x.y.z numerically', () => {
  assert.equal(newerVersion('0.17.29', '0.17.28'), true)
  assert.equal(newerVersion('0.17.10', '0.17.9'), true)
  assert.equal(newerVersion('0.17.28', '0.17.28'), false)
  assert.equal(newerVersion('0.16.99', '0.17.0'), false)
})
