/** The Today card: what finished today, what waits on you, what runs, and what today cost. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { todayView } from './today'
import { demoHub } from './hub-demo'
import { liveChats } from './archive'

test('sorts live chats into done today, needs you (with the question) and working, and sums today', () => {
  const now = Date.UTC(2026, 9, 28, 15)
  const h = demoHub(now)
  const cards = liveChats(h.chats, h.archive).map(chat => ({ chat, progress: h.progress.find(p => p.sessionId === chat.sessionId) }))
  const t = todayView(cards, h.history, h.live, now, h.jev)
  assert.deepEqual(t.done, ['Hub AIs and Starred'])
  assert.deepEqual(t.jev, { runs: 2, costUsd: 0.0184 })
  assert.deepEqual(t.needs, [{ name: 'Outfit picker copy', question: "Keep 'Closet' or rename it to 'Wardrobe'?" }])
  assert.deepEqual(t.working, ['Fix login redirect v4'])
  assert.equal(t.openCostUsd, 1.84)
  const today = h.history[h.history.length - 1]
  assert.equal(t.tokens, today.written + today.io)
})

test('a chat that finished yesterday is not done today; no usage means no numbers', () => {
  const now = Date.UTC(2026, 9, 28, 15)
  const card = { chat: { sessionId: 'a', name: 'Old', cwd: '/u/x' }, progress: { state: 'done' as const, at: now - 2 * 86_400_000 } }
  const t = todayView([card], [], [], now)
  assert.deepEqual(t.done, [])
  assert.equal(t.openCostUsd, undefined)
  assert.equal(t.tokens, undefined)
  assert.equal(t.jev, undefined)
  const old = todayView([card], [], [], now, [{ items: 3, costUsd: 1, seconds: 1, at: now - 2 * 86_400_000 }])
  assert.equal(old.jev, undefined)
})
