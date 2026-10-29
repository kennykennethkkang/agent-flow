import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanTitle, fallbackTitle, titleFor } from '../src/hub/title'

test('fallback: first five words, capitalised, no punctuation', () => {
  assert.equal(fallbackTitle('fix the login redirect loop on armasu please'), 'Fix the login redirect loop')
  assert.equal(fallbackTitle('   '), 'New chat')
})

test('cleanTitle: quotes, trailing dot and long answers trimmed', () => {
  assert.equal(cleanTitle('"Fix login redirect."'), 'Fix login redirect')
  assert.equal(cleanTitle('Title: Fix login redirect loop now please ok'), 'Fix login redirect loop now')
  assert.equal(cleanTitle(''), undefined)
})

test('titleFor: model answer when it comes, fallback when it fails or is slow', async () => {
  assert.equal(await titleFor('fix it', async () => 'Fix login redirect'), 'Fix login redirect')
  assert.equal(await titleFor('fix the login loop', async () => { throw new Error('x') }), 'Fix the login loop')
  assert.equal(await titleFor('fix the login loop', () => new Promise(r => setTimeout(() => r('Late'), 50)), 10), 'Fix the login loop')
})

test('titleFor: hands its wait to ask, so the model call can die with it', async () => {
  let got: number | undefined
  await titleFor('fix it', async (_p, ms) => { got = ms; return 'Fix it' }, 1234)
  assert.equal(got, 1234)
})
