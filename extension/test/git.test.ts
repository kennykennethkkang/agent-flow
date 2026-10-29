/**
 * The Git panel: argument building and checks, then commit, push, pull and undo
 * against a temp repo with a bare remote. Never touches a real repo.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { branchProblem, commitArgs, git, gitOp, githubRepo, parseRepoStatus, pickFiles, readRepo, syncAction } from '../src/hub/git'
import { commandProblem } from '../src/hub/routes'

describe('git args', () => {
  it('builds a commit with and without a description', () => {
    assert.deepEqual(commitArgs('Fix login', ''), ['commit', '-m', 'Fix login'])
    assert.deepEqual(commitArgs('  Fix login ', ' Why\nmore '), ['commit', '-m', 'Fix login', '-m', 'Why\nmore'])
    assert.equal(typeof commitArgs('   ', 'x'), 'string')
  })

  it('labels the sync button from upstream, ahead and behind', () => {
    assert.deepEqual(syncAction({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 0 }), { kind: 'push', label: 'Push 2' })
    assert.deepEqual(syncAction({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 3 }), { kind: 'pull', label: 'Pull 3' })
    assert.deepEqual(syncAction({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0 }), { kind: 'fetch', label: 'Fetch' })
    assert.deepEqual(syncAction({ branch: 'feat', ahead: 0, behind: 0 }), { kind: 'publish', label: 'Publish branch' })
    // Diverged: pull first, a push would be refused anyway.
    assert.equal(syncAction({ branch: 'main', upstream: 'origin/main', ahead: 1, behind: 1 }).kind, 'pull')
  })

  it('reads the GitHub page from https and ssh remotes', () => {
    for (const url of ['https://github.com/kenny/agent-flow.git', 'https://github.com/kenny/agent-flow', 'git@github.com:kenny/agent-flow.git', 'ssh://git@github.com/kenny/agent-flow.git', 'https://me@github.com/kenny/agent-flow.git'])
      assert.equal(githubRepo(url), 'https://github.com/kenny/agent-flow', url)
    assert.equal(githubRepo('https://gitlab.com/kenny/x.git'), undefined)
    assert.equal(githubRepo('git@github.com:kenny/../x.git'), undefined)
  })

  it('checks branch names before git does', () => {
    assert.equal(branchProblem('feature/login'), undefined)
    for (const bad of ['', '-f', '+main', 'a b', 'x'.repeat(201)]) assert.equal(typeof branchProblem(bad), 'string', bad)
  })

  it('takes only listed files inside the repo', () => {
    const listed = [{ path: 'a.ts', status: 'modified' as const }, { path: 'new.ts', status: 'renamed' as const, from: 'old.ts' }, { path: 'u.txt', status: 'untracked' as const }]
    const got = pickFiles(listed, ['a.ts', 'new.ts'])
    assert.ok(Array.isArray(got))
    assert.deepEqual(got.map(f => f.path), ['a.ts', 'new.ts'])
    for (const bad of [['../x'], ['/etc/passwd'], ['nope.ts'], []]) assert.equal(typeof pickFiles(listed, bad), 'string', bad.join())
  })

  it('refuses any force flag on push', async () => {
    for (const args of [['push', '--force'], ['push', '-f'], ['push', 'origin', '+main'], ['push', '--force-with-lease'], ['push', '-uf', 'origin']]) {
      const r = await git(os.tmpdir(), args)
      assert.equal(r.ok, false)
      assert.match(r.err, /force/i)
    }
  })

  it('parses porcelain v2 status with renames and untracked', () => {
    const out = ['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 a b src/a.ts', '2 R. N... 100644 100644 100644 a b R100 src/new.ts', 'src/old.ts',
      '1 A. N... 000000 100644 100644 a b added.ts', '1 .D N... 100644 100644 000000 a b gone.ts', '? notes.md', ''].join('\0')
    const s = parseRepoStatus(out)
    assert.equal(s.branch, 'main'); assert.equal(s.upstream, 'origin/main'); assert.equal(s.ahead, 2); assert.equal(s.behind, 1)
    assert.deepEqual(s.files, [
      { path: 'src/a.ts', status: 'modified' }, { path: 'src/new.ts', status: 'renamed', from: 'src/old.ts' },
      { path: 'added.ts', status: 'added' }, { path: 'gone.ts', status: 'deleted' }, { path: 'notes.md', status: 'untracked' },
    ])
    assert.equal(parseRepoStatus('# branch.head (detached)\0').branch, undefined)
  })
})

describe('hub-git route shape', () => {
  it('accepts a git command and rejects bad fields', () => {
    assert.equal(commandProblem({ type: 'hub-git', sessionId: 's', op: 'commit', files: ['a'], summary: 'x' }), undefined)
    assert.equal(commandProblem({ type: 'hub-git', sessionId: 's', op: 'sync' }), undefined)
    assert.match(commandProblem({ type: 'hub-git', sessionId: 's', op: 'force-push' }) ?? '', /op/)
    assert.match(commandProblem({ type: 'hub-git', sessionId: 's', op: 'commit', files: 'a' }) ?? '', /files/)
    assert.match(commandProblem({ type: 'hub-git', op: 'sync' }) ?? '', /sessionId/)
  })
})

describe('git ops end to end', () => {
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  let root = '', a = '', b = ''
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-git-'))
    sh(root, 'init', '--bare', '-b', 'main', 'remote.git')
    for (const name of ['a', 'b']) {
      sh(root, 'clone', '-q', 'remote.git', name)
      const dir = path.join(root, name)
      sh(dir, 'config', 'user.email', 't@t'); sh(dir, 'config', 'user.name', 'T'); sh(dir, 'config', 'commit.gpgsign', 'false')
    }
    a = path.join(root, 'a'); b = path.join(root, 'b')
    fs.writeFileSync(path.join(a, 'one.txt'), '1\n')
    sh(a, 'add', '.'); sh(a, 'commit', '-qm', 'init'); sh(a, 'push', '-q', '-u', 'origin', 'main')
    sh(b, 'pull', '-q', 'origin', 'main'); sh(b, 'branch', '-q', '--set-upstream-to=origin/main')
  })

  after(() => fs.rmSync(root, { recursive: true, force: true }))

  it('never runs a flag-shaped ref as a flag', async () => {
    sh(b, 'update-ref', 'refs/heads/--orphan=zz', 'HEAD')
    const head = sh(b, 'rev-parse', '--abbrev-ref', 'HEAD')
    assert.equal((await gitOp(b, { op: 'switch', branch: '--orphan=zz' })).ok, false)
    assert.match((await gitOp(b, { op: 'delete-branch', branch: '--orphan=zz', confirmed: true })).text, /won't delete/)
    assert.equal(sh(b, 'rev-parse', '--abbrev-ref', 'HEAD'), head)
    sh(b, 'update-ref', '-d', 'refs/heads/--orphan=zz')
  })

  it('commits only the checked files', async () => {
    fs.writeFileSync(path.join(a, 'one.txt'), '2\n')
    fs.writeFileSync(path.join(a, 'skip.txt'), 'x\n')
    const r = await gitOp(a, { op: 'commit', files: ['one.txt'], summary: 'Change one', description: 'Body' })
    assert.equal(r.ok, true, r.text)
    assert.equal(sh(a, 'log', '-1', '--format=%s%n%b'), 'Change one\nBody')
    assert.deepEqual((await readRepo(a)).files, [{ path: 'skip.txt', status: 'untracked' }])
    assert.equal((await gitOp(a, { op: 'commit', files: ['skip.txt'], summary: ' ' })).ok, false)
    assert.equal((await gitOp(a, { op: 'commit', files: [], summary: 'x' })).ok, false)
  })

  it('asks before pushing to main, then pushes to the upstream remote', async () => {
    const no = await gitOp(a, { op: 'sync' })
    assert.equal(no.ok, false)
    assert.match(no.text, /confirm/i)
    const r = await gitOp(a, { op: 'sync', confirmed: true })
    assert.equal(r.ok, true, r.text)
    assert.match(r.text, /Pushed 1 commit to origin\/main/)
  })

  it('refuses to undo a pushed commit, undoes a local one', async () => {
    assert.match((await gitOp(a, { op: 'undo', confirmed: true })).text, /pushed/i)
    fs.writeFileSync(path.join(a, 'skip.txt'), 'y\n')
    await gitOp(a, { op: 'commit', files: ['skip.txt'], summary: 'Local' })
    assert.equal((await gitOp(a, { op: 'undo' })).ok, false)
    const r = await gitOp(a, { op: 'undo', confirmed: true })
    assert.equal(r.ok, true, r.text)
    assert.equal(sh(a, 'log', '-1', '--format=%s'), 'Change one')
    assert.match(sh(a, 'status', '--porcelain'), /A  skip.txt/)
  })

  it('fetches, then pulls what another clone pushed', async () => {
    fs.writeFileSync(path.join(b, 'two.txt'), '2\n')
    sh(b, 'pull', '-q'); sh(b, 'add', '.'); sh(b, 'commit', '-qm', 'From b'); sh(b, 'push', '-q')
    const f = await gitOp(a, { op: 'sync' })
    assert.equal(f.ok, true, f.text)
    assert.equal((await readRepo(a)).behind, 1)
    const p = await gitOp(a, { op: 'sync' })
    assert.equal(p.ok, true, p.text)
    assert.match(p.text, /Pulled 1 commit/)
    assert.ok(fs.existsSync(path.join(a, 'two.txt')))
  })

  it('discards checked files, tracked and untracked, only with a confirm', async () => {
    fs.writeFileSync(path.join(a, 'one.txt'), 'changed\n')
    fs.writeFileSync(path.join(a, 'junk.txt'), 'j\n')
    assert.equal((await gitOp(a, { op: 'discard', files: ['one.txt', 'junk.txt'] })).ok, false)
    const r = await gitOp(a, { op: 'discard', files: ['one.txt', 'junk.txt', 'skip.txt'], confirmed: true })
    assert.equal(r.ok, true, r.text)
    assert.equal(fs.readFileSync(path.join(a, 'one.txt'), 'utf8'), '2\n')
    assert.equal(fs.existsSync(path.join(a, 'junk.txt')), false)
    assert.equal(fs.existsSync(path.join(a, 'skip.txt')), false)
    assert.deepEqual((await readRepo(a)).files, [])
  })

  it('creates, publishes, switches and deletes a branch', async () => {
    assert.equal((await gitOp(a, { op: 'create', branch: 'bad..name' })).ok, false)
    assert.equal((await gitOp(a, { op: 'create', branch: 'feat/x' })).ok, true)
    const view = await readRepo(a)
    assert.equal(view.branch, 'feat/x')
    assert.equal(view.upstream, undefined)
    const pub = await gitOp(a, { op: 'sync' })
    assert.equal(pub.ok, true, pub.text)
    assert.equal((await readRepo(a)).upstream, 'origin/feat/x')
    fs.writeFileSync(path.join(a, 'wip.txt'), 'w\n')
    assert.match((await gitOp(a, { op: 'switch', branch: 'main' })).text, /stash|commit/i)
    const sw = await gitOp(a, { op: 'switch', branch: 'main', stash: true })
    assert.equal(sw.ok, true, sw.text)
    assert.equal((await readRepo(a)).stashes, 1)
    assert.equal((await gitOp(a, { op: 'delete-branch', branch: 'main', confirmed: true })).ok, false)
    const del = await gitOp(a, { op: 'delete-branch', branch: 'feat/x', confirmed: true }); assert.equal(del.ok, true, del.text)
    const pop = await gitOp(a, { op: 'pop' }); assert.equal(pop.ok, true, pop.text)
    assert.ok(fs.existsSync(path.join(a, 'wip.txt')))
  })

  it('commits and pushes in one press, asking first on main', async () => {
    const head = sh(a, 'rev-parse', 'HEAD')
    const no = await gitOp(a, { op: 'commit-push', files: ['wip.txt'], summary: 'Wip' })
    assert.match(no.text, /confirm the push to origin\/main/i)
    assert.equal(sh(a, 'rev-parse', 'HEAD'), head)
    const r = await gitOp(a, { op: 'commit-push', files: ['wip.txt'], summary: 'Wip', confirmed: true })
    assert.equal(r.ok, true, r.text)
    assert.equal(r.text, 'Committed 1 file to main and pushed to origin/main')
    assert.equal(sh(root, '--git-dir=remote.git', 'log', '-1', '--format=%s', 'main'), 'Wip')
  })
})
