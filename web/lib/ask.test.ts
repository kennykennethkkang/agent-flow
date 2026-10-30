import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askChoice } from './ask'

const single = { question: 'Day?', options: ['Mon', 'Tue'] }
const multi = { question: 'Meals?', options: ['Eggs', 'Rice', 'Soup'], multiSelect: true }

test('picks go out as they are, and the answer waits on every question', () => {
  assert.deepEqual(askChoice([single, multi], [1, [0, 2]], {}), [1, [0, 2]])
  assert.equal(askChoice([single, multi], [1, []], {}), undefined)
  assert.equal(askChoice([single, multi], [1], {}), undefined)
})

test('open Other text replaces a single pick and joins multiSelect ticks', () => {
  assert.deepEqual(askChoice([single, multi], [undefined, [1]], { 0: 'Wed 5pm', 1: 'zed' }), [{ other: 'Wed 5pm' }, { picks: [1], other: 'zed' }])
  assert.deepEqual(askChoice([multi], [[]], { 0: ' zed ' }), [{ other: 'zed' }])
})

test('an open Other with no text holds the answer back', () => {
  assert.equal(askChoice([single], [0], { 0: '   ' }), undefined)
})
