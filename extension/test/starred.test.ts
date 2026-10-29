/**
 * Starred chats: the toggle, and each star's digest built from hub state and notes.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { starredRows, toggleStar } from '../src/hub/starred'
import type { HubState } from '../src/hub/types'

describe('starred', () => {
  it('stars once and unstars', () => {
    const one = toggleStar([], { sessionId: 'a', ai: 'claude', name: 'n', cwd: '/c' }, true, 5)
    assert.equal(toggleStar(one, { sessionId: 'a', ai: 'claude', name: 'n', cwd: '/c' }, true, 6).length, 1)
    assert.equal(toggleStar(one, { sessionId: 'a', ai: 'claude', name: 'n', cwd: '/c' }, false, 7).length, 0)
  })

  it('builds the digest from the live chat, the newest note, and keeps a closed chat', () => {
    const state = {
      chats: [{ pid: 1, sessionId: 'a', name: 'agentFlow', cwd: '/u/Armasu', link: '', live: true, why: [], updatedAt: 9 }],
      live: [{ sessionId: 'a', cwd: '/u/Armasu', prompt: 'add codex', limits: [], at: 1 }],
    } as unknown as HubState
    const list = [
      { sessionId: 'a', ai: 'claude' as const, name: 'old', cwd: '/u/Armasu', starredAt: 1 },
      { sessionId: 'b', ai: 'codex' as const, name: 'gone', cwd: '/u/x', starredAt: 2 },
    ]
    const rows = starredRows(list, state, { a: 'x'.repeat(400) })
    assert.equal(rows[0].name, 'agentFlow')
    assert.equal(rows[0].live, true)
    assert.equal(rows[0].digest.lastPrompt, 'add codex')
    assert.equal(rows[0].digest.note?.length, 300)
    assert.equal(starredRows(list, state, {}, { b: 'Armasu · continued' })[1].chain, 'Armasu · continued')
    assert.equal(rows[0].digest.resume, 'claude --resume a')
    assert.equal(rows[1].name, 'gone')
    assert.equal(rows[1].live, false)
    assert.equal(rows[1].digest.resume, 'codex resume b')
  })
})
