/**
 * The Git panel's buttons: plain git and gh calls with argument arrays, no shell, never a force push.
 * Only Kenneth's presses run these; chats never commit. Called from hub-panel.ts.
 */
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { cliPath } from './ais'
import { insideCwd } from './local'
import type { GitOp, RepoFile, RepoView } from './types'

const QUICK = 15_000
const SLOW = 60_000
const MAIN = /^(main|master)$/
// No credential prompt, no editor, and status skips index.lock so the refresh never races an op. Pathspecs go literal per call (LIT): set globally it breaks stash -u.
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_EDITOR: 'true', GH_PROMPT_DISABLED: '1', GIT_OPTIONAL_LOCKS: '0' }
const LIT = '--literal-pathspecs'
const FORCE = /^(--force(-with-lease|-if-includes)?(=.*)?|-[a-zA-Z]*f[a-zA-Z]*|\+.*)$/

type Ran = { ok: boolean; out: string; err: string }
export type GitCmd = { op: GitOp; files?: string[]; summary?: string; description?: string; branch?: string; stash?: boolean; confirmed?: boolean }
export type GitResult = { ok: boolean; text: string; open?: string }
type Status = { branch?: string; upstream?: string; ahead: number; behind: number; files: RepoFile[] }

/** input: written to stdin (hash-object --stdin, mktree). */
function exec(file: string, args: string[], timeoutMs: number, cwd?: string, input?: string): Promise<Ran> {
  return new Promise(resolve => {
    const c = execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 8 << 20, windowsHide: true, env: ENV }, (err, out, e) =>
      resolve({ ok: !err, out: String(out), err: err?.killed ? `${path.basename(file)} timed out` : String(e) || err?.message || '' }))
    if (input !== undefined) c.stdin?.end(input)
  })
}

// The one forced push: the to-do ref alone, leased on the commit the user saw (todo.ts replaceRemote).
const TODO_LEASE = /^--force-with-lease=refs\/switchboard\/todo:[0-9a-f]{40}$/
const todoLease = (args: string[]) => args.filter(a => FORCE.test(a)).every(a => TODO_LEASE.test(a))
  && args.filter(a => !a.startsWith('-')).join(' ') === 'push origin refs/switchboard/todo:refs/switchboard/todo'

export function git(root: string, args: string[], timeoutMs = QUICK, input?: string): Promise<Ran> {
  if (args[0] === 'push' && args.some(a => FORCE.test(a)) && !todoLease(args)) return Promise.resolve({ ok: false, out: '', err: 'Switchboard never force pushes' })
  return exec('git', ['-C', root, ...args], timeoutMs, undefined, input)
}

/** The first line of stderr worth showing. */
export const why = (r: Ran) => r.err.split('\n').filter(l => !/^\s*hint:/i.test(l)).map(l => l.replace(/^(error|fatal|remote): /i, '').trim()).find(Boolean) ?? 'git failed'

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const no = (text: string): GitResult => ({ ok: false, text })

/** `git status --porcelain=v2 --branch -z -uall`. */
export function parseRepoStatus(out: string): Status {
  const s: Status = { ahead: 0, behind: 0, files: [] }
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const row = parts[i], f = row.split(' ')
    if (row.startsWith('# branch.head ')) { if (f[2] !== '(detached)') s.branch = row.slice(14) }
    else if (row.startsWith('# branch.upstream ')) s.upstream = row.slice(18)
    else if (row.startsWith('# branch.ab ')) { s.ahead = Math.abs(Number(f[2])) || 0; s.behind = Math.abs(Number(f[3])) || 0 }
    else if (row.startsWith('1 ')) s.files.push({ path: f.slice(8).join(' '), status: f[1].includes('D') ? 'deleted' : f[1].includes('A') ? 'added' : 'modified' })
    else if (row.startsWith('2 ')) s.files.push({ path: f.slice(9).join(' '), status: 'renamed', from: parts[++i] })
    else if (row.startsWith('u ')) s.files.push({ path: f.slice(10).join(' '), status: 'conflict' })
    else if (row.startsWith('? ')) s.files.push({ path: row.slice(2), status: 'untracked' })
  }
  return s
}

/** The one sync button: publish with no upstream, pull when behind (diverged too), push when ahead, else fetch. */
export function syncAction(s: Pick<Status, 'upstream' | 'ahead' | 'behind'> & { branch?: string }): { kind: 'publish' | 'pull' | 'push' | 'fetch'; label: string } {
  if (!s.upstream) return { kind: 'publish', label: 'Publish branch' }
  if (s.behind) return { kind: 'pull', label: `Pull ${s.behind}` }
  if (s.ahead) return { kind: 'push', label: `Push ${s.ahead}` }
  return { kind: 'fetch', label: 'Fetch' }
}

/** https://github.com/<owner>/<repo> from an https, git@ or ssh:// remote; undefined for anything else. */
export function githubRepo(url: string): string | undefined {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())
  if (!m || m[1].startsWith('.') || m[2].startsWith('.')) return undefined
  return `https://github.com/${m[1]}/${m[2]}`
}

/** A quick check; git check-ref-format has the last word. */
export function branchProblem(name: string): string | undefined {
  if (!name || name.length > 200) return 'Give a branch name'
  if (name === '@') return '"@" is not a valid branch name'
  if (/^[-+]/.test(name) || /[\s~^:?*[\\]|\.\.|@\{/.test(name)) return `"${name}" is not a valid branch name`
  return undefined
}

export function commitArgs(summary: string, description: string): string[] | string {
  const s = summary.trim(), d = description.trim()
  if (!s) return 'Write a commit summary first'
  return d ? ['commit', '-m', s, '-m', d] : ['commit', '-m', s]
}

/** Only files git status lists, by their exact repo-relative path; a string says why not. */
export function pickFiles(listed: RepoFile[], asked: string[]): RepoFile[] | string {
  if (!asked.length) return 'Check at least one file'
  const got: RepoFile[] = []
  for (const p of new Set(asked)) {
    const f = listed.find(x => x.path === p)
    if (!f || !insideCwd('/r', p) || (f.from && !insideCwd('/r', f.from))) return `${p} is not in this repo's changes`
    got.push(f)
  }
  return got
}

const status = async (root: string) => parseRepoStatus((await git(root, ['status', '--porcelain=v2', '--branch', '-z', '-uall'])).out)
const config = async (root: string, key: string) => (await git(root, ['config', '--get', key])).out.trim()
const branches = async (root: string) => (await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).out.split('\n').filter(Boolean)

/** Where a push goes: the branch's own upstream, or origin when it has none yet (publish). Never another remote by default. */
async function pushTarget(root: string, s: Status): Promise<{ remote: string; name: string; publish: boolean }> {
  const b = s.branch ?? ''
  if (!s.upstream) return { remote: 'origin', name: b, publish: true }
  const merge = await config(root, `branch.${b}.merge`)
  return { remote: (await config(root, `branch.${b}.remote`)) || 'origin', name: merge.replace(/^refs\/heads\//, '') || b, publish: false }
}

// HEAD:refs/heads/<name> so a branch name can never read as a flag or a +force refspec.
const push = (root: string, t: { remote: string; name: string; publish: boolean }) =>
  git(root, ['push', ...(t.publish ? ['-u'] : []), t.remote, `HEAD:refs/heads/${t.name}`], SLOW)

let ghAt: string | undefined
/** VS Code's PATH often lacks Homebrew's bin. A miss is not cached, so installing gh later works. */
export const ghPath = async () => (ghAt ??= (await cliPath('gh')) ?? ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI', 'gh.exe')].find(f => fs.existsSync(f)))

const prs = new Map<string, { at: number; pr?: RepoView['pr'] }>()
const PR_MS = 2 * 60_000
async function prFor(root: string, repo: string, branch: string, gh: string): Promise<RepoView['pr']> {
  const key = `${repo}\n${branch}`, hit = prs.get(key)
  if (hit && Date.now() - hit.at < PR_MS) return hit.pr
  const r = await exec(gh, ['pr', 'view', branch, '--repo', repo.replace('https://github.com/', ''), '--json', 'url,state,title,number,additions,deletions,baseRefName'], QUICK, root)
  let pr: RepoView['pr']
  try {
    const j = JSON.parse(r.out)
    if (typeof j.url === 'string') pr = { url: j.url, state: String(j.state), title: String(j.title), number: Number(j.number) || undefined, additions: Number(j.additions) || 0, deletions: Number(j.deletions) || 0, base: typeof j.baseRefName === 'string' ? j.baseRefName : undefined }
  } catch { /* none, or gh not signed in */ }
  prs.set(key, { at: Date.now(), pr })
  return pr
}

type Ci = NonNullable<RepoView['ci']>
const RUN_MS = 30_000
const FAILED = new Set(['failure', 'timed_out', 'startup_failure'])
const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

/** `gh run list --json ...` and `gh run view --json jobs` as the CI card's run; undefined with no run. */
export function parseRun(list: string, view?: string): Ci | undefined {
  let r: Record<string, unknown> | undefined, jobs: unknown[] = []
  try { r = JSON.parse(list)[0] } catch { return undefined }
  if (!r || typeof r.databaseId !== 'number' || !text(r.url)) return undefined
  try { jobs = view ? JSON.parse(view).jobs ?? [] : [] } catch { /* none yet */ }
  const conclusion = text(r.conclusion)
  return {
    id: r.databaseId, workflow: text(r.workflowName) ?? 'Workflow', status: String(r.status), ...(conclusion ? { conclusion } : {}), url: String(r.url),
    sha: String(r.headSha ?? '').slice(0, 7), at: Date.parse(String(r.updatedAt)) || 0,
    jobs: (Array.isArray(jobs) ? jobs : []).map(j => {
      const o = j as { name?: unknown; status?: unknown; conclusion?: unknown; steps?: { name?: unknown; conclusion?: unknown }[] }
      const c = text(o.conclusion), step = c && FAILED.has(c) ? text(o.steps?.find(st => FAILED.has(String(st.conclusion)))?.name) : undefined
      return { name: text(o.name) ?? 'job', status: String(o.status), ...(c ? { conclusion: c } : {}), ...(step ? { step } : {}) }
    }),
  }
}

const runs = new Map<string, { at: number; ci?: Ci }>()
/** The branch's newest Actions run; cached shorter while it runs. */
async function runFor(root: string, repo: string, branch: string, gh: string): Promise<Ci | undefined> {
  const key = `${repo}\n${branch}`, hit = runs.get(key)
  if (hit && Date.now() - hit.at < (hit.ci && hit.ci.status !== 'completed' ? RUN_MS : PR_MS)) return hit.ci
  const R = ['--repo', repo.replace('https://github.com/', '')]
  const l = await exec(gh, ['run', 'list', ...R, '--branch', branch, '--limit', '1', '--json', 'databaseId,status,conclusion,workflowName,url,headSha,updatedAt'], QUICK, root)
  const first = l.ok ? parseRun(l.out) : undefined
  // Jobs for the dots row: one more call only when the run changed.
  const same = !!first && hit?.ci?.id === first.id && hit.ci.at === first.at
  const ci = same ? hit!.ci : first && parseRun(l.out, (await exec(gh, ['run', 'view', String(first.id), ...R, '--json', 'jobs'], QUICK, root)).out)
  runs.set(key, { at: Date.now(), ci })
  return ci
}

type Merge = NonNullable<RepoView['merge']>
const CUT = 120

/** The branch a PR would merge into: the PR's base, else origin/HEAD's, else main or master. ref prefers the remote-tracking one. */
export function pickBase(prBase: string | undefined, originHead: string, refs: string[], remote: string): { name: string; ref: string } | undefined {
  const names = prBase ? [prBase] : [originHead.startsWith(`${remote}/`) ? originHead.slice(remote.length + 1) : '', 'main', 'master'].filter(Boolean)
  for (const name of names) {
    if (branchProblem(name)) continue
    const ref = [`${remote}/${name}`, name].find(r => refs.includes(r))
    if (ref) return { name, ref }
  }
  return undefined
}

/** `git merge-tree --write-tree -z --name-only --no-messages`: the merged tree, then each conflicted path. undefined when git is too old (< 2.38). */
export function parseMergeTree(out: string): { tree: string; files: string[] } | undefined {
  const [tree, ...rest] = out.split('\0')
  if (!/^[0-9a-f]{40,64}$/.test(tree)) return undefined
  return { tree, files: [...new Set(rest.filter(Boolean))] }
}

/** The first conflict hunk in a merged file: the first line where the two sides differ, numbered as in ours. */
export function firstConflict(text: string): { line: number; ours: string; theirs: string } | undefined {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(l => l.startsWith('<<<<<<<'))
  if (start < 0) return undefined
  const ours: string[] = [], theirs: string[] = []
  let side: string[] | undefined = ours
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith('>>>>>>>')) break
    if (l.startsWith('|||||||')) side = undefined
    else if (l === '=======') side = theirs
    else side?.push(l)
  }
  let k = 0
  while (k < ours.length && k < theirs.length && ours[k] === theirs[k]) k++
  if (k >= ours.length && k >= theirs.length) k = 0
  const cut = (s = '') => s.trim().slice(0, CUT)
  return { line: start + 1 + k, ours: cut(ours[k]), theirs: cut(theirs[k]) }
}

/** `git log --format=%h%x00%an%x00%ae%x00%ct` rows; my own email reads as You. */
export function parseCommits(out: string, me: string): Merge['commits'] {
  return out.split('\n').filter(Boolean).map(l => {
    const [hash, name, email, ct] = l.split('\0')
    return { hash, author: me && email?.toLowerCase() === me.toLowerCase() ? 'You' : name, at: Number(ct) * 1000 }
  })
}

// Keyed by both tips, so a refresh with nothing new runs no merge-tree.
const merges = new Map<string, { key: string; merge: Merge }>()

/** The PR card's data: how this branch stands against its base. Read only: merge-tree writes objects, never the worktree, index, HEAD or refs. */
export async function readMerge(root: string, branch: string, remote: string, prBase?: string): Promise<Merge | undefined> {
  const [head, refs, me] = await Promise.all([
    git(root, ['symbolic-ref', '-q', '--short', `refs/remotes/${remote}/HEAD`]),
    git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', `refs/remotes/${remote}`]),
    config(root, 'user.email'),
  ])
  const base = pickBase(prBase, head.out.trim(), refs.out.split('\n').filter(Boolean), remote)
  if (!base || base.name === branch) return undefined
  const tips = await git(root, ['rev-parse', 'HEAD', base.ref])
  if (!tips.ok) return undefined
  const key = `${base.ref} ${tips.out} ${me}`, hit = merges.get(root)
  if (hit?.key === key) return hit.merge
  const [log, count] = await Promise.all([
    git(root, ['log', '-8', '--format=%h%x00%an%x00%ae%x00%ct', `${base.ref}...HEAD`]),
    git(root, ['rev-list', '--count', `HEAD..${base.ref}`]),
  ])
  const merge: Merge = { base: base.name, behind: Number(count.out.trim()) || 0, files: 0, conflicts: [], commits: parseCommits(log.out, me) }
  // Only a base that moved past the merge-base can conflict.
  if (merge.behind) {
    const t = parseMergeTree((await git(root, ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', 'HEAD', base.ref])).out)
    if (!t) merge.conflicts = undefined
    else {
      merge.files = t.files.length
      merge.conflicts = await Promise.all(t.files.slice(0, 5).map(async p => {
        const [blob, by] = await Promise.all([
          git(root, ['cat-file', 'blob', `${t.tree}:${p}`]),
          git(root, [LIT, 'log', '-1', '--format=%h%x00%an%x00%ae%x00%ct', `HEAD..${base.ref}`, '--', p]),
        ])
        return { path: p, by: parseCommits(by.out, me)[0]?.author ?? base.name, ...firstConflict(blob.out) }
      }))
    }
  }
  merges.set(root, { key, merge })
  return merge
}

export const repoRoot = async (cwd: string) => { const r = await git(cwd, ['rev-parse', '--show-toplevel']); return r.ok ? r.out.trim() : undefined }

export async function readRepo(root: string, gh?: string): Promise<Omit<RepoView, 'sessionId' | 'busy' | 'result'>> {
  const [s, heads, log, stash] = await Promise.all([status(root), branches(root), git(root, ['log', '-15', '--format=%h%x09%s%x09%ar']), git(root, ['stash', 'list', '--format=%gd'])])
  const remote = (s.branch && (await config(root, `branch.${s.branch}.remote`))) || 'origin'
  const github = githubRepo((await git(root, ['remote', 'get-url', remote])).out)
  const pr = github && gh && s.branch && s.upstream ? await prFor(root, github, (await pushTarget(root, s)).name, gh) : undefined
  const merge = s.branch ? await readMerge(root, s.branch, remote, pr?.base).catch(() => undefined) : undefined
  const ci = github && gh && s.branch && s.upstream ? await runFor(root, github, (await pushTarget(root, s)).name, gh).catch(() => undefined) : undefined
  return {
    merge,
    name: path.basename(root), branch: s.branch, upstream: s.upstream, ahead: s.ahead, behind: s.behind, files: s.files, branches: heads, sync: syncAction(s),
    log: log.out.split('\n').filter(Boolean).map(l => { const [hash, subject, when] = l.split('\t'); return { hash, subject: subject ?? '', when: when ?? '' } }),
    stashes: stash.out.split('\n').filter(Boolean).length, github, pr, ...(ci ? { ci } : {}), at: Date.now(),
  }
}

/** Deletes untracked files one by one, only plain paths whose folder stays inside the repo. */
async function removeUntracked(root: string, files: RepoFile[]): Promise<string | undefined> {
  const top = await fs.promises.realpath(root)
  for (const f of files) {
    const full = path.join(root, f.path)
    const dir = await fs.promises.realpath(path.dirname(full)).catch(() => '')
    if (dir !== top && !dir.startsWith(top + path.sep)) return `${f.path} leads outside the repo, so it was left alone`
    if ((await fs.promises.lstat(full)).isDirectory()) return `${f.path} is a folder, so it was left alone`
    await fs.promises.unlink(full)
  }
  return undefined
}

/** One button press. Refuses rather than guesses; confirmed comes from the in-page confirm. */
export async function gitOp(root: string, c: GitCmd, gh?: string): Promise<GitResult> {
  // Any op may change the branch's PR and run; look again after it.
  prs.clear()
  runs.clear()
  const s = await status(root)
  const pushConfirm = (t: { remote: string; name: string }) => (MAIN.test(t.name) && !c.confirmed ? `Confirm the push to ${t.remote}/${t.name} first` : undefined)
  switch (c.op) {
    case 'commit':
    case 'commit-push': {
      const args = commitArgs(c.summary ?? '', c.description ?? '')
      if (typeof args === 'string') return no(args)
      if (!s.branch) return no('Not on a branch (detached HEAD), so nothing was committed')
      const files = pickFiles(s.files, c.files ?? [])
      if (typeof files === 'string') return no(files)
      const t = await pushTarget(root, s)
      const ask = c.op === 'commit-push' ? pushConfirm(t) : undefined
      if (ask) return no(ask)
      const paths = files.flatMap(f => (f.from ? [f.from, f.path] : [f.path]))
      const add = await git(root, [LIT, 'add', '-A', '--', ...paths])
      if (!add.ok) return no(why(add))
      // The paths again so anything else already staged stays out of this commit. Hooks may run, hence the long timeout.
      const made = await git(root, [LIT, ...args, '--', ...paths], SLOW)
      if (!made.ok) return no(why(made))
      const done = `Committed ${plural(files.length, 'file')} to ${s.branch}`
      if (c.op === 'commit') return { ok: true, text: done }
      const p = await push(root, t)
      return p.ok ? { ok: true, text: `${done} and pushed to ${t.remote}/${t.name}` } : no(`${done}, but the push failed: ${why(p)}`)
    }
    case 'sync': {
      if (!s.branch) return no('Not on a branch (detached HEAD)')
      const kind = syncAction(s).kind
      if (kind === 'push' || kind === 'publish') {
        const t = await pushTarget(root, s)
        const ask = pushConfirm(t)
        if (ask) return no(ask)
        const p = await push(root, t)
        if (!p.ok) return no(why(p))
        return { ok: true, text: kind === 'publish' ? `Published ${s.branch} to ${t.remote}/${t.name}` : `Pushed ${plural(s.ahead, 'commit')} to ${t.remote}/${t.name}` }
      }
      if (kind === 'pull') {
        const p = await git(root, ['pull', '--ff-only'], SLOW)
        return p.ok ? { ok: true, text: `Pulled ${plural(s.behind, 'commit')} into ${s.branch}` } : no(why(p))
      }
      const f = await git(root, ['fetch'], SLOW)
      if (!f.ok) return no(why(f))
      const after = await status(root)
      return { ok: true, text: after.behind ? `Fetched: ${plural(after.behind, 'commit')} to pull` : 'Fetched: up to date' }
    }
    case 'undo': {
      if (!c.confirmed) return no('Confirm the undo first')
      if (!(await git(root, ['rev-parse', '--verify', '-q', 'HEAD~1'])).ok) return no('There is no earlier commit to go back to')
      if ((await git(root, ['branch', '-r', '--contains', 'HEAD'])).out.trim()) return no('The last commit is already pushed, so it stays')
      const subject = (await git(root, ['log', '-1', '--format=%s'])).out.trim()
      const r = await git(root, ['reset', '--soft', 'HEAD~1'])
      return r.ok ? { ok: true, text: `Undid "${subject}": its changes are staged again` } : no(why(r))
    }
    case 'discard': {
      if (!c.confirmed) return no('Confirm the discard first')
      const files = pickFiles(s.files, c.files ?? [])
      if (typeof files === 'string') return no(files)
      const tracked = files.filter(f => f.status !== 'untracked').flatMap(f => (f.from ? [f.from, f.path] : [f.path]))
      if (tracked.length) {
        const r = await git(root, [LIT, 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked])
        if (!r.ok) return no(why(r))
      }
      const problem = await removeUntracked(root, files.filter(f => f.status === 'untracked'))
      return problem ? no(problem) : { ok: true, text: `Discarded ${plural(files.length, 'file')}` }
    }
    case 'switch': {
      const b = c.branch ?? ''
      // A ref made outside git branch can look like a flag (--orphan=x).
      if (branchProblem(b)) return no(`Switchboard won't switch to ${b}`)
      if (!(await branches(root)).includes(b)) return no(`There is no local branch named ${b}`)
      if (b === s.branch) return no(`Already on ${b}`)
      if (s.files.length) {
        if (!c.stash) return no('Commit or stash the changes first')
        const st = await git(root, ['stash', 'push', '-u', '-m', `Switchboard: before switching to ${b}`])
        if (!st.ok) return no(why(st))
      }
      const r = await git(root, ['switch', b])
      return r.ok ? { ok: true, text: `Switched to ${b}${s.files.length ? '; the changes are in the stash' : ''}` } : no(why(r))
    }
    case 'create': {
      const b = c.branch?.trim() ?? ''
      const bad = branchProblem(b)
      if (bad) return no(bad)
      if (!(await git(root, ['check-ref-format', '--branch', b])).ok) return no(`"${b}" is not a valid branch name`)
      if ((await branches(root)).includes(b)) return no(`${b} already exists`)
      const r = await git(root, ['switch', '-c', b])
      return r.ok ? { ok: true, text: `Created ${b} and switched to it` } : no(why(r))
    }
    case 'delete-branch': {
      const b = c.branch ?? ''
      if (!c.confirmed) return no('Confirm the delete first')
      if (branchProblem(b)) return no(`Switchboard won't delete ${b}`)
      if (MAIN.test(b)) return no(`${b} is never deleted from here`)
      if (b === s.branch) return no('That is the current branch')
      if (!(await branches(root)).includes(b)) return no(`There is no local branch named ${b}`)
      // -d, not -D: git keeps a branch with unmerged commits.
      const r = await git(root, ['branch', '-d', b])
      return r.ok ? { ok: true, text: `Deleted ${b}` } : no(why(r))
    }
    case 'stash': {
      if (!s.files.length) return no('Nothing to stash')
      const r = await git(root, ['stash', 'push', '-u', '-m', `Switchboard ${new Date().toISOString().slice(0, 16)}`])
      return r.ok ? { ok: true, text: `Stashed ${plural(s.files.length, 'file')}` } : no(why(r))
    }
    case 'pop': {
      const r = await git(root, ['stash', 'pop'])
      return r.ok ? { ok: true, text: 'Popped the last stash' } : no(why(r))
    }
    case 'rerun': {
      // The run is looked up here, never taken from the page.
      if (!gh || !s.branch || !s.upstream) return no('No GitHub Actions run to re-run')
      const t = await pushTarget(root, s)
      const repo = githubRepo((await git(root, ['remote', 'get-url', t.remote])).out)
      const ci = repo && await runFor(root, repo, t.name, gh)
      if (!repo || !ci || ci.status !== 'completed' || !FAILED.has(ci.conclusion ?? '')) return no('The last run did not fail, so nothing was re-run')
      const r = await exec(gh, ['run', 'rerun', String(ci.id), '--failed', '--repo', repo.replace('https://github.com/', '')], QUICK, root)
      runs.clear()
      return r.ok ? { ok: true, text: `Re-running the failed jobs in ${ci.workflow}` } : no(why(r))
    }
    case 'pr': {
      if (!s.branch || !s.upstream) return no('Publish the branch first')
      const t = await pushTarget(root, s)
      const repo = githubRepo((await git(root, ['remote', 'get-url', t.remote])).out)
      if (!repo) return no(`${t.remote} is not a GitHub remote`)
      const compare = `${repo}/compare/${t.name.split('/').map(encodeURIComponent).join('/')}?expand=1`
      if (!gh) return { ok: true, text: 'Opened the compare page (gh is not installed)', open: compare }
      if (!(await exec(gh, ['auth', 'status'], QUICK, root)).ok) return { ok: true, text: 'gh is not signed in (run gh auth login), so the compare page opened', open: compare }
      // --repo pins the base to this branch's remote, never another one gh might pick.
      const r = await exec(gh, ['pr', 'create', '--repo', repo.replace('https://github.com/', ''), '--head', t.name, '--fill', '--web'], SLOW, root)
      return r.ok ? { ok: true, text: 'Opened the new pull request in your browser' } : { ok: true, text: `gh said: ${why(r)}; the compare page opened`, open: compare }
    }
  }
}
