/** The orbit picture only runs its frame loop while something on it moves. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approach, groupRoles, orbitMoves, PILL_MS, satSlot, SAT_ROW } from './orbit-motion'

test('a working chat, a chat waiting on you, or an active role keeps the picture moving', () => {
  assert.equal(orbitMoves({ state: 'working' }, [], true), true)
  assert.equal(orbitMoves({ state: 'needs-you' }, [], true), true)
  assert.equal(orbitMoves({ state: 'idle', progress: { roles: [{ role: 'engineer', state: 'active' }] } }, [], true), true)
})

test('an idle or finished chat with nothing fading is one still frame', () => {
  assert.equal(orbitMoves({ state: 'idle' }, [], true), false)
  assert.equal(orbitMoves({ state: 'done', progress: { roles: [{ role: 'qa', state: 'done' }] } }, [PILL_MS + 1], true), false)
})

test('a tool pill still fading keeps it moving, unless tool calls are hidden', () => {
  assert.equal(orbitMoves({ state: 'done' }, [PILL_MS - 1], true), true)
  assert.equal(orbitMoves({ state: 'done' }, [PILL_MS - 1], false), false)
})

test('a still chat keeps moving while a change is still settling', () => {
  assert.equal(orbitMoves({ state: 'idle' }, [], true, true), true)
})

test('approach eases toward the target the same at any frame rate, and lands on it', () => {
  const at60 = Array.from({ length: 6 }).reduce<number>(v => approach(v, 1, 1000 / 60, 100), 0)
  const at30 = Array.from({ length: 3 }).reduce<number>(v => approach(v, 1, 1000 / 30, 100), 0)
  assert.ok(Math.abs(at60 - at30) < 1e-9)
  assert.ok(at60 > 0.6 && at60 < 0.7)
  assert.equal(approach(0.9995, 1, 16, 100), 1)
  assert.equal(approach(0, 1, Infinity, 100), 1)
})

test('groupRoles: one row per role in first-seen order, with its running ids', () => {
  const g = groupRoles([
    { id: 'r1', role: 'researcher', state: 'done' },
    { id: 'e1', role: 'engineer', state: 'active' },
    { id: 'e2', role: 'engineer', state: 'active' },
    { id: 'e0', role: 'engineer', state: 'done' },
    { id: 'q1', role: 'qa', state: 'active' },
  ])
  assert.deepEqual(g, [
    { role: 'researcher', state: 'done', running: [] },
    { role: 'engineer', state: 'active', running: ['e1', 'e2'] },
    { role: 'qa', state: 'active', running: ['q1'] },
  ])
})

test('satSlot: a row fans out centered on the outward line; a full row starts the next one further out', () => {
  assert.deepEqual(satSlot(0, 1), { row: 0, at: 0 })
  assert.deepEqual([0, 1, 2].map(i => satSlot(i, 3)?.at), [-1, 0, 1])
  assert.deepEqual(satSlot(SAT_ROW, SAT_ROW + 2), { row: 1, at: -0.5 })
  assert.equal(satSlot(SAT_ROW * 2, SAT_ROW * 2 + 1), undefined)
})
