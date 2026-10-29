import { it } from 'node:test'
import assert from 'node:assert/strict'
import { orphanTab } from '../src/orphan-tab'

const sb = (isActive: boolean, viewColumn = 1) => ({ isActive, group: { viewColumn }, input: { viewType: 'mainThreadWebview-agentVisualizer' } })

it('finds the Switchboard tab on screen that no panel in this extension host owns', () => {
  const tab = sb(true)
  assert.equal(orphanTab([{ isActive: false, group: { viewColumn: 1 }, input: undefined }, tab], []), tab)
})

it('leaves it alone when a live panel shows in its group, or it is in the background and not revived yet', () => {
  assert.equal(orphanTab([sb(true)], [1]), undefined)
  assert.equal(orphanTab([sb(false)], []), undefined)
})

it('with two tabs, closing one leaves the other owned, and only an unowned one is picked', () => {
  const left = sb(true, 1)
  const right = sb(true, 2)
  assert.equal(orphanTab([left], [1]), undefined)
  assert.equal(orphanTab([left, right], [1]), right)
})

it('ignores other webviews and text tabs', () => {
  assert.equal(orphanTab([
    { isActive: true, group: { viewColumn: 1 }, input: { viewType: 'mainThreadWebview-markdown.preview' } },
    { isActive: true, group: { viewColumn: 1 }, input: { uri: 'x' } },
  ], []), undefined)
})
