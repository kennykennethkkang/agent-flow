/** History: closed chats grouped by origin, and kept out of the live list. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { archiveChains, chatProjects, inProjects, filterChains, hideIdle, historyCount, liveChats, liveVersion, splitVersion } from './archive'
import { demoHub } from './hub-demo'
import type { ArchivedChat } from './hub-types'

const row = (sessionId: string, origin: string, version: number, archivedAt: number): ArchivedChat =>
  ({ sessionId, ai: 'claude', name: version > 1 ? `${origin} v${version}` : origin, origin, version, cwd: '/u/Armasu', project: 'Armasu', archivedAt })

test('splits a chat name into its origin and version', () => {
  assert.deepEqual(splitVersion('Fix login redirect v3'), { origin: 'Fix login redirect', version: 3 })
  assert.deepEqual(splitVersion('Armasu · continued · 2'), { origin: 'Armasu · continued', version: 2 })
  assert.deepEqual(splitVersion('Fix login redirect'), { origin: 'Fix login redirect', version: 1 })
  assert.deepEqual(splitVersion(undefined), { origin: '', version: 1 })
})

test('an archived chat leaves the live list', () => {
  const chats = [{ sessionId: 'a' }, { sessionId: 'b' }]
  assert.deepEqual(liveChats(chats, [row('a', 'Fix', 1, 1)]).map(c => c.sessionId), ['b'])
})

test('groups closed chats by origin, newest chain first, versions newest first', () => {
  const chains = archiveChains([row('a1', 'Fix', 1, 10), row('b1', 'Other', 1, 15), row('a2', 'Fix', 2, 20)])
  assert.deepEqual(chains.map(c => [c.origin, c.latest.version, c.versions.map(v => v.version)]), [['Fix', 2, [2, 1]], ['Other', 1, [1]]])
})

test('the demo shows the working chat\'s History chain of three versions and its next chat live', () => {
  const h = demoHub(0)
  const chains = archiveChains(h.archive)
  assert.equal(chains.length, 2)
  assert.deepEqual(chains[0].versions.map(v => v.version), [3, 2, 1])
  assert.equal(liveVersion(chains[0], liveChats(h.chats, h.archive)), 4)
  assert.equal(h.keep.onFull, 'fresh')
})

test('History search keeps chains whose name or note matches, and names the live version that carries a chain on', () => {
  const chains = archiveChains([row('a1', 'Fix login', 1, 10), row('b1', 'Outfit copy', 1, 15)])
  assert.deepEqual(filterChains(chains, 'outfit', new Set()).map(c => c.origin), ['Outfit copy'])
  assert.deepEqual(filterChains(chains, 'cookie', new Set(['a1'])).map(c => c.origin), ['Fix login'])
  assert.equal(filterChains(chains, '  ', new Set()).length, 2)
  const chats = [{ sessionId: 'x', name: 'Fix login v2', cwd: '/u/Armasu' }, { sessionId: 'y', name: 'Fix login v5', cwd: '/elsewhere' }]
  assert.equal(liveVersion(chains.find(c => c.origin === 'Fix login')!, chats), 2)
  assert.equal(liveVersion(chains.find(c => c.origin === 'Outfit copy')!, chats), undefined)
})

test('counts History as chains and chats', () => {
  assert.equal(historyCount(archiveChains([row('a1', 'Fix', 1, 10), row('a2', 'Fix', 2, 20), row('b1', 'Other', 1, 15)])), '2 chains, 3 chats')
  assert.equal(historyCount(archiveChains([row('a1', 'Fix', 1, 10)])), '1 chain, 1 chat')
})

test('hides chats idle longer than the setting, never one that works, waits on you or is picked', () => {
  const now = 10 * 3600_000
  const card = (id: string, state: 'working' | 'idle' | 'needs-you' | 'done' | undefined, minsAgo: number, status?: string) =>
    ({ chat: { sessionId: id, cwd: '/u/x', status, updatedAt: now - minsAgo * 60e3 }, progress: state ? { state, at: now - minsAgo * 60e3 } : undefined })
  const cards = [card('work', 'working', 90), card('idle-old', 'idle', 20), card('idle-new', 'idle', 10), card('ask', 'needs-you', 90),
    card('done-old', 'done', 20), card('nohook-old', undefined, 20, 'idle'), card('picked', 'idle', 90)]
  assert.deepEqual(hideIdle(cards, 15, 'picked', now).map(c => c.chat.sessionId), ['work', 'idle-new', 'ask', 'picked'])
  assert.equal(hideIdle(cards, null, undefined, now).length, cards.length)
})

test('lists the projects chats run in, most chats first, and filters by the picked ones', () => {
  const cwds = ['/u/Armasu', '/u/agent-flow', '/u/Armasu/', '/u/claude-mods', '/u/agent-flow/extension']
  assert.deepEqual(chatProjects(cwds, []), [{ name: 'Armasu', count: 2 }, { name: 'agent-flow', count: 1 }, { name: 'claude-mods', count: 1 }, { name: 'extension', count: 1 }])
  // A picked project with no chat left stays listed, so it can be unpicked.
  assert.deepEqual(chatProjects(['/u/Armasu'], ['Gone']), [{ name: 'Armasu', count: 1 }, { name: 'Gone', count: 0 }])
  assert.equal(inProjects('/u/Armasu', []), true)
  assert.equal(inProjects('/u/Armasu/', ['Armasu']), true)
  assert.equal(inProjects('/u/agent-flow', ['Armasu']), false)
})
