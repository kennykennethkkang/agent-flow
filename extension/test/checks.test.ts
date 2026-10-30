/** The tests card's run record from Bash hooks, and the CI card's run from gh. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTestCommand, step, testOutcome } from '../src/hub/progress'
import { parseRun } from '../src/hub/git'

const ev = (hook_event_name: string, extra: Record<string, unknown> = {}) => ({ session_id: 's', cwd: '/r', hook_event_name, ...extra })
const run = (events: Record<string, unknown>[]) => events.reduce((p, e, i) => step(p, e, 1000 + i), undefined as ReturnType<typeof step>)

test('isTestCommand: test runners anywhere in a chain, not mentions', () => {
  for (const c of ['npm test', 'cd extension && npm test && npx tsc --noEmit -p .', 'pnpm run test:unit', 'yarn test', 'bun test', 'npx tsx --test lib/*.test.ts',
    'node --test test/', 'npx vitest run', 'npx vitest run -t "adds | subtracts"', 'jest --ci', 'CI=1 pytest -q', 'python -m pytest tests', 'go test ./...', 'cargo test', 'claude plugin test ./mods/x', 'npm test 2>&1 | tail -20'])
    assert.ok(isTestCommand(c), c)
  for (const c of ['npm install', 'grep -rn jest src', 'echo test', 'git commit -m "npm test fixes"', 'npx tsc --noEmit', 'ls test/',
    'grep -E "vitest|jest" package.json', 'rg "pytest|go test" -n', 'echo "see (npm test)"', "echo 'a; npm test'", 'ls node_modules/.bin | grep jest', 'npm i -D vitest', 'grep -c "npm test" README.md'])
    assert.ok(!isTestCommand(c), c)
})

test('testOutcome: node spec counts, first failure and the tail', () => {
  const out = ['✔ a (1ms)', '✖ rcInList ignores a reused pid (2.1ms)', '  AssertionError', 'ℹ tests 538', 'ℹ pass 536', 'ℹ fail 2', '', 'ℹ duration_ms 900',
    '✖ failing tests:', '', '✖ rcInList ignores a reused pid (2.1ms)', 'x'.repeat(300)].join('\n')
  const o = testOutcome(out)
  assert.equal(o.failed, 2)
  assert.equal(o.total, 538)
  assert.equal(o.first, 'rcInList ignores a reused pid')
  assert.equal(o.tail.length, 8)
  assert.equal(o.tail.at(-1)!.length, 160)
  assert.ok(o.tail.every(l => l.trim()))
})

test('testOutcome: tap, vitest, jest, pytest, go and cargo', () => {
  assert.deepEqual(pick(testOutcome('not ok 3 - parses a pid\n# tests 10\n# fail 1')), [1, 10, 'parses a pid'])
  assert.deepEqual(pick(testOutcome(' × lib/a.test.ts > adds 3ms\n Tests  2 failed | 8 passed (10)')), [2, 10, 'lib/a.test.ts > adds'])
  assert.deepEqual(pick(testOutcome('  ● Auth › logs in\nTests:       1 failed, 4 passed, 5 total')), [1, 5, 'Auth › logs in'])
  assert.deepEqual(pick(testOutcome('FAILED tests/test_a.py::test_login - assert 1\n==== 1 failed, 3 passed in 0.2s ====')), [1, 4, 'test_login'])
  assert.deepEqual(pick(testOutcome('--- FAIL: TestLogin (0.00s)\nFAIL')), [undefined, undefined, 'TestLogin'])
  assert.deepEqual(pick(testOutcome('test auth::login ... FAILED\ntest result: FAILED. 3 passed; 1 failed; 0 ignored')), [1, 4, 'auth::login'])
  assert.deepEqual(pick(testOutcome('ℹ tests 5\nℹ pass 5\nℹ fail 0')), [0, 5, undefined])
})
const pick = (o: ReturnType<typeof testOutcome>) => [o.failed, o.total, o.first]

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } })

test('step: a failed test run is recorded from PostToolUseFailure', () => {
  const p = run([ev('SessionStart'), ev('PostToolUseFailure', { ...bash('npm test'), error: 'Exit code 1\nnot ok 2 - rcInList ignores a reused pid\n# tests 538\n# fail 2' })])
  assert.deepEqual(p?.tests, { command: 'npm test', ok: false, at: 1001, failed: 2, total: 538, first: 'rcInList ignores a reused pid', tail: ['not ok 2 - rcInList ignores a reused pid', '# tests 538', '# fail 2'] })
})

test('step: a piped run that exits 0 still fails on its count; a later pass replaces it', () => {
  const failed = run([ev('SessionStart'), ev('PostToolUse', { ...bash('npm test 2>&1 | tail'), tool_response: { stdout: '# tests 4\n# fail 1', stderr: '' } })])
  assert.equal(failed?.tests?.ok, false)
  const passed = step(failed, ev('PostToolUse', { ...bash('npm test'), tool_response: { stdout: '# tests 4\n# fail 0', stderr: '' } }), 2000)
  assert.equal(passed?.tests?.ok, true)
  assert.equal(passed?.tests?.at, 2000)
})

test('step: other commands, background and interrupted runs leave tests alone', () => {
  const p = run([ev('SessionStart'), ev('PostToolUseFailure', { ...bash('npm test'), error: 'Exit code 1\n# fail 1' })])
  for (const e of [ev('PostToolUse', { ...bash('ls'), tool_response: { stdout: '' } }), ev('PostToolUseFailure', { ...bash('npx tsc'), error: 'Exit code 2' }),
    ev('PostToolUse', { ...bash('npm test'), tool_response: { stdout: '', backgroundTaskId: 'b1' } }), ev('PostToolUse', { ...bash('npm test'), tool_response: { stdout: '', interrupted: true } }),
    ev('PostToolUseFailure', { ...bash('npm test'), error: 'Exit code 130\n# fail 1', is_interrupt: true })])
    assert.equal(step(p, e, 5000)?.tests?.at, 1001)
})

const list = JSON.stringify([{ databaseId: 42, status: 'completed', conclusion: 'failure', workflowName: 'CI', url: 'https://github.com/o/r/actions/runs/42', headSha: 'abcdef1234567', updatedAt: '2026-10-29T10:00:00Z' }])
const jobs = JSON.stringify({ jobs: [
  { name: 'lint', status: 'completed', conclusion: 'success', steps: [{ name: 'Run lint', conclusion: 'success' }] },
  { name: 'test', status: 'completed', conclusion: 'failure', steps: [{ name: 'Checkout', conclusion: 'success' }, { name: 'npm test', conclusion: 'failure' }, { name: 'Upload', conclusion: 'skipped' }] },
] })

test('parseRun: the newest run with its jobs and first failed step', () => {
  assert.deepEqual(parseRun(list, jobs), {
    id: 42, workflow: 'CI', status: 'completed', conclusion: 'failure', url: 'https://github.com/o/r/actions/runs/42', sha: 'abcdef1', at: Date.parse('2026-10-29T10:00:00Z'),
    jobs: [{ name: 'lint', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'completed', conclusion: 'failure', step: 'npm test' }],
  })
})

test('parseRun: no runs, bad json or a run with no jobs yet', () => {
  assert.equal(parseRun('[]'), undefined)
  assert.equal(parseRun('not json'), undefined)
  assert.equal(parseRun('[{"status":"queued"}]'), undefined)
  assert.deepEqual(parseRun(list.replace('"completed"', '"in_progress"').replace('"failure"', '""'), 'oops')?.jobs, [])
  assert.equal(parseRun(list.replace('"completed"', '"in_progress"').replace('"failure"', '""'))?.conclusion, undefined)
})
