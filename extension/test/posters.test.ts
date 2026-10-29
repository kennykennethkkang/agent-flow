import { it } from 'node:test'
import assert from 'node:assert/strict'
import { Posters, tickWork } from '../src/hub/posters'

it('sends to every poster, and removing one leaves the others', () => {
  const posters = new Posters<string>()
  const a: string[] = []
  const b: string[] = []
  const offA = posters.add(m => a.push(m))
  posters.add(m => b.push(m))
  posters.send('x')
  offA()
  posters.send('y')
  assert.deepEqual(a, ['x'])
  assert.deepEqual(b, ['x', 'y'])
  assert.equal(posters.size, 1)
})

it('sends only to shown views, and counts them', () => {
  const posters = new Posters<string>()
  const got: string[] = []
  let visible = false
  posters.add(m => got.push(m), () => visible)
  posters.send('hidden')
  assert.equal(posters.shown, 0)
  visible = true
  posters.send('shown')
  assert.equal(posters.shown, 1)
  assert.deepEqual(got, ['shown'])
})

it('the 15 s tick: everything while a view shows, only handoffs while views are hidden, nothing with no view', () => {
  assert.equal(tickWork(1, 2, false), 'full')
  assert.equal(tickWork(0, 2, false), 'essentials')
  assert.equal(tickWork(0, 0, false), 'none')
  // The standalone app reading /hub/state counts as a shown view.
  assert.equal(tickWork(0, 0, true), 'full')
})
