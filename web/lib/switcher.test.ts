/** The quick switcher: live chats and History versions, matched by substring first, then loosely. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchName, rankItems, switcherItems } from './switcher'
import { demoHub } from './hub-demo'
import { liveChats } from './archive'

test('matches a substring first, then letters in order, and says which letters', () => {
  assert.deepEqual(matchName('Fix login redirect', 'login'), [4, 5, 6, 7, 8])
  assert.deepEqual(matchName('Fix login redirect', 'LOGIN'), [4, 5, 6, 7, 8])
  assert.deepEqual(matchName('Fix login redirect', 'flr'), [0, 4, 10])
  assert.equal(matchName('Fix login redirect', 'xyz'), null)
  assert.deepEqual(matchName('Anything', ''), [])
  // Letters, not UTF-16 units: the rocket is one letter, so 'Fix' starts at 2.
  const name = '\u{1F680} Fix login', hits = matchName(name, 'fix')!
  assert.deepEqual(hits, [2, 3, 4])
  assert.equal([...name].filter((_, i) => hits.includes(i)).join(''), 'Fix')
})

test('lists live chats, then every History version, and ranks a name that starts with the query first', () => {
  const h = demoHub(0)
  const cards = liveChats(h.chats, h.archive).map(chat => ({ chat, progress: h.progress.find(p => p.sessionId === chat.sessionId) }))
  const items = switcherItems(cards, h.archive)
  assert.equal(items.filter(i => i.kind === 'live').length, cards.length)
  assert.deepEqual(items.filter(i => i.kind === 'history').map(i => `${i.name} v${i.version}`), ['Fix login redirect v3', 'Fix login redirect v2', 'Fix login redirect v1', 'Cookie banner copy v1'])
  const ranked = rankItems(items, 'login')
  assert.ok(ranked.length >= 4)
  assert.equal(ranked[0].item.kind, 'live')
  assert.equal(ranked[0].item.version, 4)
  assert.deepEqual(rankItems(items, 'outfit').map(r => r.item.name), ['Outfit picker copy'])
  assert.equal(rankItems(items, '').length, items.length)
})
