/** The chat's step and its time left, from its own pace so far. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eta, say } from './eta'
import type { ChatProgress } from './hub-types'

const MIN = 60e3
const base = { sessionId: 's', cwd: '/r', state: 'working' as const, roles: [], startedAt: 0, at: 0 }

test('eta: average of finished tasks times what is open, less time spent on the current one', () => {
  const p: ChatProgress = { ...base, tasks: [
    { id: '1', subject: 'a', status: 'completed', startedAt: 0, doneAt: 10 * MIN },
    { id: '2', subject: 'b', status: 'completed', startedAt: 10 * MIN, doneAt: 30 * MIN },
    { id: '3', subject: 'c', status: 'in_progress', startedAt: 30 * MIN },
    { id: '4', subject: 'd', status: 'pending' },
  ] }
  const e = eta(p, 35 * MIN)
  assert.equal(e.done, 2)
  assert.equal(e.current?.subject, 'c')
  assert.equal(e.perTaskMs, 15 * MIN)
  assert.equal(e.leftMs, 25 * MIN)
})

test('eta: no finished task means no estimate; untimed tasks spread the chat time', () => {
  assert.equal(eta({ ...base, tasks: [{ id: '1', subject: 'a', status: 'pending' }] }, MIN).leftMs, undefined)
  const old = eta({ ...base, tasks: [{ id: '1', subject: 'a', status: 'completed', doneAt: 20 * MIN }, { id: '2', subject: 'b', status: 'pending' }] }, 20 * MIN)
  assert.equal(old.leftMs, 20 * MIN)
})

test('say rounds to plain words', () => {
  assert.equal(say(20e3), 'under a minute')
  assert.equal(say(4 * MIN), 'about 4 min')
  assert.equal(say(118 * MIN), 'about 2 h')
  assert.equal(say(83 * MIN), 'about 1 h 25 min')
})
