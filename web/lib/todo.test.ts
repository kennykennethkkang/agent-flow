import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inside, openElsewhere, ordered, runCount, runIds, runLanded, runTargets } from './todo'
import type { ChatRow, TodoItem } from './hub-types'

const t = (id: string, before?: string): TodoItem => ({ id, text: id, at: 1, ...(before ? { before } : {}) })

describe('todo panel helpers', () => {
  it('puts each prerequisite indented directly above its item; one whose item is gone stands alone', () => {
    const rows = ordered([t('a'), t('b'), t('p', 'b'), t('pp', 'p'), t('q', 'gone')])
    assert.deepEqual(rows.map(r => [r.t.id, r.depth]), [['a', 0], ['pp', 2], ['p', 1], ['b', 0], ['q', 0]])
    assert.deepEqual(ordered([t('x', 'y'), t('y', 'x')]).map(r => r.t.id).sort(), ['x', 'y'])
  })
  it('counts what a run does: the picked items and their open prerequisites', () => {
    const list = [t('a'), t('b'), t('p', 'b'), t('pp', 'p')]
    assert.equal(runCount(list, ['b']), 3)
    assert.equal(runCount(list, ['a', 'p']), 3)
    assert.equal(runCount(list, ['gone']), 0)
  })
  it('counts open items in other projects', () => {
    assert.equal(openElsewhere({ '/a': { todo: [t('1'), t('2')] }, '/b': { todo: [t('3')] }, '/c': { todo: [] } }, '/b'), 2)
    assert.equal(openElsewhere(undefined, '/b'), 0)
  })
  it('offers running chats in the project that take messages', () => {
    const c = (sessionId: string, cwd: string, live = true, takes = true): ChatRow => ({ pid: 1, sessionId, cwd, link: '', live, why: [], takes })
    const chats = [c('in', '/u/app/web'), c('root', '/u/app'), c('other', '/u/apple'), c('dead', '/u/app', false), c('mute', '/u/app', true, false)]
    assert.deepEqual(runTargets(chats, '/u/app').map(x => x.sessionId), ['in', 'root'])
    assert.equal(inside('C:\\u\\app', 'c:/u/app/x'), true)
  })
})

describe('run landed', () => {
  const todo: TodoItem[] = [{ id: 'a', text: 'A', at: 1, chat: 's1' }, { id: 'b', text: 'B', at: 1 }]
  it('counts an item already in the chat it was sent to as sent', () => {
    assert.equal(runLanded(todo, ['a'], new Map([['a', 's1']]), 's1'), true)
    assert.equal(runLanded(todo, ['b'], new Map(), 's1'), false)
  })
  it('waits for a new chat to take the items, even ones that were in an ended chat', () => {
    const was = new Map([['a', 's1']])
    assert.equal(runLanded(todo, ['a'], was), false)
    assert.equal(runLanded([{ ...todo[0], chat: 'new' }], ['a'], was), true)
    assert.equal(runLanded([], ['a'], was), true)
  })
  it('runs the picked items with their open prerequisites', () => {
    const list: TodoItem[] = [{ id: 'a', text: 'A', at: 1 }, { id: 'p', text: 'P', at: 1, before: 'a' }, { id: 'pp', text: 'PP', at: 1, before: 'p' }, { id: 'x', text: 'X', at: 1 }]
    assert.deepEqual([...runIds(list, ['a', 'gone'])].sort(), ['a', 'p', 'pp'])
    assert.equal(runCount(list, ['a']), 3)
  })
})
