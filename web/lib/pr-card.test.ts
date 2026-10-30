/** The PR card's words, built from the repo view with no model call. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pill, resolvePrompt, short, summary } from './pr-card'
import type { RepoView } from './hub-types'

type R = Pick<RepoView, 'pr' | 'merge'>
const pr = { url: 'u', state: 'OPEN', title: 't', number: 128, additions: 482, deletions: 37, base: 'main' }
const c = (path: string, by: string) => ({ path, by, line: 42, ours: 'a', theirs: 'b' })
const conflicted: R = { pr, merge: { base: 'main', behind: 3, files: 2, conflicts: [c('src/auth.ts', 'Lena'), c('src/middleware.ts', 'Lena')], commits: [] } }

test('summary: open PR with conflicts names who and which files', () => {
  assert.equal(summary(conflicted), 'PR #128 is open, but main moved on while we worked: Lena changed the same lines in auth.ts and middleware.ts. I can merge main and resolve them.')
})

test('summary: several authors, more files than shown, no PR', () => {
  const r: R = { merge: { base: 'dev', behind: 4, files: 7, conflicts: [c('a.ts', 'Lena'), c('b.ts', 'Sam'), c('c.ts', 'Lena')], commits: [] } }
  assert.equal(summary(r), 'dev moved on while we worked: Lena and Sam changed the same lines in a.ts, b.ts, c.ts and 4 more. I can merge dev and resolve them.')
})

test('summary: clean, up to date, and old git', () => {
  assert.equal(summary({ pr, merge: { base: 'main', behind: 3, files: 0, conflicts: [], commits: [] } }), 'PR #128 is open. main has 3 new commits, and they merge cleanly.')
  assert.equal(summary({ merge: { base: 'main', behind: 1, files: 0, conflicts: [], commits: [] } }), 'This branch is behind main by 1 commit, and it merges cleanly.')
  assert.equal(summary({ merge: { base: 'main', behind: 0, files: 0, conflicts: [], commits: [] } }), 'This branch is up to date with main.')
  assert.equal(summary({ pr, merge: { base: 'main', behind: 2, files: 0, commits: [] } }), 'PR #128 is open. main has 2 new commits.')
})

test('resolvePrompt lists the files and says not to commit', () => {
  assert.equal(resolvePrompt(conflicted.merge!), 'Merge main into this branch and resolve the conflicts in src/auth.ts, src/middleware.ts. Keep both intents where possible, run the tests, and do not commit.')
})

test('pill and short age', () => {
  assert.equal(pill(conflicted), '#128 · 2 conflicts · +482 −37')
  assert.equal(pill({ merge: { base: 'main', behind: 0, files: 0, conflicts: [], commits: [] } }), 'No PR yet')
  assert.deepEqual([0, 30e3, 6 * 60e3, 2 * 3600e3, 3 * 86400e3].map(ms => short(1e9 - ms, 1e9)), ['now', 'now', '6m', '2h', '3d'])
})
