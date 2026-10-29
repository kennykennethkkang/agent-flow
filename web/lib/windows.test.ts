import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { byWindow, windowOf } from './windows'
import type { WindowInfo } from './hub-types'

const windows: WindowInfo[] = [
  { workspace: '/g/agent-flow', name: 'agent-flow', color: 'violet' },
  { workspace: '/g/Armasu', name: 'Armasu', color: 'amber' },
  { workspace: '/g/Armasu/web', name: 'web', color: 'teal' },
]
const card = (id: string, cwd: string) => ({ chat: { sessionId: id, cwd } })

describe('chats by window', () => {
  it('finds the window that holds a folder, the deepest first', () => {
    assert.equal(windowOf('/g/agent-flow', windows)?.name, 'agent-flow')
    assert.equal(windowOf('/g/Armasu/web/src', windows)?.name, 'web')
    assert.equal(windowOf('/g/Armasu/api', windows)?.name, 'Armasu')
    assert.equal(windowOf('/g/agent-flow-2', windows), undefined)
    assert.equal(windowOf('C:\\g\\x\\sub', [{ workspace: 'C:\\g\\x', name: 'x', color: 'rose' }])?.name, 'x')
  })

  it('puts this window first, the others by name, and Other last; cards keep their order', () => {
    const cards = [card('1', '/g/Armasu'), card('2', '/tmp/x'), card('3', '/g/agent-flow/web'), card('4', '/g/Armasu/api')]
    const groups = byWindow(cards, windows, '/g/agent-flow')
    assert.deepEqual(groups.map(g => [g.window?.name, g.here, g.cards.map(c => c.chat.sessionId)]), [
      ['agent-flow', true, ['3']],
      ['Armasu', false, ['1', '4']],
      [undefined, false, ['2']],
    ])
  })

  it('has no this window outside VS Code, and one plain group with no windows known', () => {
    const cards = [card('1', '/g/Armasu'), card('2', '/g/agent-flow')]
    assert.deepEqual(byWindow(cards, windows).map(g => [g.window?.name, g.here]), [['agent-flow', false], ['Armasu', false]])
    assert.deepEqual(byWindow(cards, []).map(g => [g.window, g.cards.length]), [[undefined, 2]])
  })
})
