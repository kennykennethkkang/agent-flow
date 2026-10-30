/** The tests, CI and usage-limit cards' words, from hub data with no model call. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ciLine, ciState, limitLine, testsLine, testsPrompt } from './checks'
import type { CiRun, TestRun } from './hub-types'

const t: TestRun = { command: 'npm test', ok: false, at: 1, failed: 2, total: 538, first: 'rcInList ignores a reused pid', tail: ['✖ rcInList ignores a reused pid', 'ℹ fail 2'] }

test('testsLine: counts and first failure when known', () => {
  assert.equal(testsLine(t), 'The last test run failed 2 of 538, first: rcInList ignores a reused pid.')
  assert.equal(testsLine({ ...t, total: undefined, first: undefined }), 'The last test run had 2 failures.')
  assert.equal(testsLine({ ...t, failed: 1, total: undefined }), 'The last test run had 1 failure, first: rcInList ignores a reused pid.')
  assert.equal(testsLine({ command: 'go test ./...', ok: false, at: 1 }), 'The last test run failed.')
})

test('testsPrompt: the command and the tail', () => {
  assert.equal(testsPrompt(t), 'The last test run failed: npm test\n\n✖ rcInList ignores a reused pid\nℹ fail 2\n\nFix the failing tests and run them again.')
  assert.equal(testsPrompt({ command: 'pytest', ok: false, at: 1 }), 'The last test run failed: pytest\n\nFix the failing tests and run them again.')
})

const ci: CiRun = { id: 42, workflow: 'CI', status: 'completed', conclusion: 'failure', url: 'u', sha: 'abcdef1', at: 1, jobs: [
  { name: 'lint', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'completed', conclusion: 'failure', step: 'npm test' }] }

test('ciState: running, failed, passed, other', () => {
  assert.equal(ciState({ ...ci, status: 'in_progress', conclusion: undefined }), 'running')
  assert.equal(ciState(ci), 'failed')
  assert.equal(ciState({ ...ci, conclusion: 'timed_out' }), 'failed')
  assert.equal(ciState({ ...ci, conclusion: 'success' }), 'passed')
  assert.equal(ciState({ ...ci, conclusion: 'cancelled' }), 'other')
})

test('ciLine: names the failed job and step, or how far a run is', () => {
  assert.equal(ciLine(ci), 'CI failed on abcdef1: test broke at "npm test". Re-run the failed jobs, or ask the chat to fix it.')
  assert.equal(ciLine({ ...ci, jobs: [] }), 'CI failed on abcdef1.')
  assert.equal(ciLine({ ...ci, status: 'in_progress', conclusion: undefined, jobs: [ci.jobs[0], { name: 'test', status: 'in_progress' }] }), 'CI is running on abcdef1: 1 of 2 jobs done.')
  assert.equal(ciLine({ ...ci, status: 'queued', conclusion: undefined, jobs: [] }), 'CI is running on abcdef1.')
  assert.equal(ciLine({ ...ci, conclusion: 'success' }), 'CI passed on abcdef1, all 2 jobs green.')
  assert.equal(ciLine({ ...ci, conclusion: 'cancelled' }), 'CI ended cancelled on abcdef1.')
})

test('limitLine: the used-up limit\'s reset and who continues', () => {
  const now = new Date(2026, 9, 29, 12, 0).getTime()
  const at = (h: number, d = 29) => new Date(2026, 9, d, h, 30).toISOString()
  const limits = [{ kind: 'five_hour', percentUsed: 100, resetsAt: at(14) }, { kind: 'seven_day', percentUsed: 60, resetsAt: at(9, 31) }]
  assert.equal(limitLine(limits, true, now), 'Resets at 14:30. Auto-continue is on, so Claude Code picks it up then.')
  assert.equal(limitLine(limits, false, now), 'Resets at 14:30. Auto-continue is off; Switchboard sends it again a minute after.')
  assert.equal(limitLine([{ kind: 'seven_day', percentUsed: 100, resetsAt: at(9, 31) }], true, now), 'Resets Sat 09:30. Auto-continue is on, so Claude Code picks it up then.')
  assert.equal(limitLine([], false, now), 'Auto-continue is off; Switchboard sends it again a minute after the reset.')
})
