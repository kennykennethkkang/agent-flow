import { test } from 'node:test'
import assert from 'node:assert/strict'
import { taskTotals } from './progress'
import { demoHub } from './hub-demo'

const t = (status: 'pending' | 'in_progress' | 'completed') => ({ id: status, subject: status, status })

test('sums done and total over the chats that have tasks, and says it in a line', () => {
  const cards = [
    { progress: { tasks: [t('completed'), t('in_progress'), t('pending')] } },
    { progress: { tasks: [t('completed')] } },
    { progress: { tasks: [] } },
    {},
  ]
  assert.deepEqual(taskTotals(cards), { done: 2, total: 4, chats: 2, text: '2 of 4 tasks done across 2 chats' })
  assert.deepEqual(taskTotals([cards[1]]), { done: 1, total: 1, chats: 1, text: '1 of 1 task done' })
  assert.deepEqual(taskTotals([{}, cards[2]]), { done: 0, total: 0, chats: 0, text: '' })
})

test('the demo has tasks on more than one chat', () => {
  const h = demoHub(0)
  assert.ok(taskTotals(h.progress.map(progress => ({ progress }))).chats >= 3)
})
