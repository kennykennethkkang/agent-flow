/**
 * The Git panel's PR card: base pick, merge-tree and log parsing, then a real conflict
 * on a temp repo, read without touching the worktree, index or HEAD.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { firstConflict, parseCommits, parseMergeTree, pickBase, readMerge } from '../src/hub/git'

describe('merge parsing', () => {
  it('picks the PR base, then origin/HEAD, then main or master', () => {
    const refs = ['main', 'feat', 'origin/main', 'origin/dev', 'master']
    assert.deepEqual(pickBase('dev', 'origin/main', refs, 'origin'), { name: 'dev', ref: 'origin/dev' })
    assert.deepEqual(pickBase(undefined, 'origin/main', refs, 'origin'), { name: 'main', ref: 'origin/main' })
    assert.deepEqual(pickBase(undefined, '', refs, 'origin'), { name: 'main', ref: 'origin/main' })
    assert.deepEqual(pickBase(undefined, '', ['master', 'feat'], 'origin'), { name: 'master', ref: 'master' })
    assert.equal(pickBase(undefined, '', ['feat'], 'origin'), undefined)
    assert.equal(pickBase('-x', '', refs, 'origin'), undefined)
  })

  it('reads the tree and conflicted paths from merge-tree -z --name-only', () => {
    const oid = 'a'.repeat(40)
    assert.deepEqual(parseMergeTree(`${oid}\0src/auth.ts\0b c.ts\0\0`), { tree: oid, files: ['src/auth.ts', 'b c.ts'] })
    assert.deepEqual(parseMergeTree(`${oid}\0`), { tree: oid, files: [] })
    assert.equal(parseMergeTree('usage: git merge-tree'), undefined)
  })

  it('finds the first conflict hunk and the first line the sides differ on', () => {
    const text = ['a', 'b', '<<<<<<< HEAD', 'same', '  mine();', '=======', 'same', '  theirs();', '>>>>>>> main', 'z'].join('\n')
    assert.deepEqual(firstConflict(text), { line: 4, ours: 'mine();', theirs: 'theirs();' })
    const diff3 = ['<<<<<<< HEAD', 'x', '||||||| base', 'o', '=======', '', '>>>>>>> main'].join('\r\n')
    assert.deepEqual(firstConflict(diff3), { line: 1, ours: 'x', theirs: '' })
    assert.equal(firstConflict('no markers\n'), undefined)
    assert.equal(firstConflict(`<<<<<<< HEAD\n${'q'.repeat(300)}\n=======\nr\n>>>>>>> m`)?.ours.length, 120)
  })

  it('reads log rows and calls my own commits You', () => {
    const out = [['abc1234', 'Lena', 'lena@x', '100'], ['def5678', 'Ken', 'ME@x', '200'], []].map(r => r.join('\0')).join('\n')
    assert.deepEqual(parseCommits(out, 'me@x'), [{ hash: 'abc1234', author: 'Lena', at: 100_000 }, { hash: 'def5678', author: 'You', at: 200_000 }])
  })
})

describe('merge view on a temp repo', () => {
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  let root = ''
  const commit = (who: string, email: string, msg: string) => sh(root, '-c', `user.name=${who}`, '-c', `user.email=${email}`, 'commit', '-qam', msg)
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-merge-'))
    sh(root, 'init', '-q', '-b', 'main')
    sh(root, 'config', 'user.email', 'me@x'); sh(root, 'config', 'user.name', 'Me'); sh(root, 'config', 'commit.gpgsign', 'false')
    fs.writeFileSync(path.join(root, 'auth.ts'), 'a\nb\nkey = 1\nc\n')
    fs.writeFileSync(path.join(root, 'ok.ts'), 'x\n')
    sh(root, 'add', '.'); commit('Me', 'me@x', 'init')
    sh(root, 'switch', '-q', '-c', 'feat')
    fs.writeFileSync(path.join(root, 'auth.ts'), 'a\nb\nkey = mine\nc\n'); commit('Me', 'me@x', 'mine')
  })
  after(() => fs.rmSync(root, { recursive: true, force: true }))

  it('shows the timeline but no conflicts while main has not moved', async () => {
    const m = await readMerge(root, 'feat', 'origin')
    assert.equal(m?.base, 'main')
    assert.equal(m?.behind, 0)
    assert.equal(m?.files, 0)
    assert.deepEqual(m?.conflicts, [])
    assert.deepEqual(m?.commits.map(c => c.author), ['You'])
  })

  it('has no conflicts when main moved on other lines', async () => {
    sh(root, 'switch', '-q', 'main')
    fs.writeFileSync(path.join(root, 'ok.ts'), 'y\n'); commit('Sam', 'sam@x', 'other file')
    sh(root, 'switch', '-q', 'feat')
    const m = await readMerge(root, 'feat', 'origin')
    assert.equal(m?.behind, 1)
    assert.equal(m?.files, 0)
    assert.deepEqual(m?.conflicts, [])
  })

  it('finds the conflict and its lines, leaving the worktree, index and HEAD alone', async () => {
    sh(root, 'switch', '-q', 'main')
    fs.writeFileSync(path.join(root, 'auth.ts'), 'a\nb\nkey = rotated\nc\n'); commit('Lena', 'lena@x', 'rotate keys')
    sh(root, 'switch', '-q', 'feat')
    fs.writeFileSync(path.join(root, 'ok.ts'), 'dirty\n')
    const head = sh(root, 'rev-parse', 'HEAD'), status = sh(root, 'status', '--porcelain'), index = sh(root, 'ls-files', '-s')
    const m = await readMerge(root, 'feat', 'origin')
    assert.equal(m?.behind, 2)
    assert.equal(m?.files, 1)
    assert.deepEqual(m?.conflicts, [{ path: 'auth.ts', by: 'Lena', line: 3, ours: 'key = mine', theirs: 'key = rotated' }])
    assert.deepEqual(m?.commits.map(c => c.author).sort(), ['Lena', 'Sam', 'You'])
    assert.equal(sh(root, 'rev-parse', 'HEAD'), head)
    assert.equal(sh(root, 'status', '--porcelain'), status)
    assert.equal(sh(root, 'ls-files', '-s'), index)
    assert.equal(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat')
  })

  it('has nothing to say on the base branch itself', async () => {
    assert.equal(await readMerge(root, 'main', 'origin'), undefined)
  })
})
