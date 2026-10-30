'use client'
import { useEffect, useRef, useState } from 'react'
import type { ChatRow, GitOp, RepoFile, RepoView } from '@/lib/hub-types'
import type { HubCommand } from '@/lib/vscode-bridge'
import { boxNote } from '@/lib/message-box'
import { resolvePrompt } from '@/lib/pr-card'
import { caps, panel } from './look'
import { PrCard } from './pr-card'
import { CiCard } from './check-cards'

type Git = Omit<Extract<HubCommand, { type: 'hub-git' }>, 'type' | 'sessionId'>
type Ask = { text: string; yes: string; cmd: Git }

const small = { padding: '6px 10px', fontSize: 12 } as const
const field = { font: '400 13px/1.4 var(--hub-sans)', padding: '7px 10px', borderRadius: 8, minWidth: 0, background: 'var(--hub-canvas)', color: 'var(--hub-ink)', border: '1px solid var(--hub-hair)' } as const
const TAG: Record<RepoFile['status'], string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflict: '!' }
const MAIN = /^(main|master)$/
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
// origin/main -> origin, main. A new branch publishes to origin/<branch>.
const target = (r: RepoView) => {
  if (!r.upstream) return { remote: 'origin', name: r.branch ?? '' }
  const i = r.upstream.indexOf('/')
  return { remote: r.upstream.slice(0, i), name: r.upstream.slice(i + 1) }
}

/** Kenneth's git buttons for the chat's repo: each one a plain git or gh command in the extension, never run by a chat. */
export function GitPanel({ repo, sessionId, chat, commit, isVSCode, send }: {
  repo: RepoView | null | undefined; sessionId: string; chat?: ChatRow; commit?: string; isVSCode: boolean; send: (c: HubCommand) => void
}) {
  const mine = repo?.sessionId === sessionId ? repo : null
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [typed, setTyped] = useState(false)
  const [menu, setMenu] = useState(false)
  const [newBranch, setNewBranch] = useState('')
  const [ask, setAsk] = useState<Ask | null>(null)
  const sent = useRef<{ op: GitOp; at: number } | undefined>(undefined)

  // The chat's commit message fills the form until Kenneth types in it.
  useEffect(() => {
    if (typed || !commit) return
    const [first, ...rest] = commit.split('\n')
    setSummary(first.trim()); setDescription(rest.join('\n').trim())
  }, [commit, typed])
  // A commit that went through clears the form.
  const result = mine?.result
  useEffect(() => {
    if (!result?.ok || !sent.current || result.at < sent.current.at) return
    if (sent.current.op === 'commit' || sent.current.op === 'commit-push') { setSummary(''); setDescription(''); setTyped(true); setUnchecked(new Set()) }
    sent.current = undefined
  }, [result])

  if (!mine) return null
  const r = mine
  const busy = !!r.busy
  const run = (cmd: Git) => { sent.current = { op: cmd.op, at: Date.now() }; setAsk(null); send({ type: 'hub-git', sessionId, ...cmd }) }
  const open = (url: string) => (isVSCode ? send({ type: 'hub-open-url', url }) : window.open(url, '_blank', 'noopener'))
  const checked = r.files.filter(f => !unchecked.has(f.path)).map(f => f.path)
  const t = target(r)
  // Pushing to main or master asks in the page first.
  const pushing = (cmd: Git, what: string) => (MAIN.test(t.name) ? setAsk({ text: `${what} to ${t.remote}/${t.name}?`, yes: 'Push', cmd: { ...cmd, confirmed: true } }) : run(cmd))
  const sync = () => (r.sync.kind === 'push' || r.sync.kind === 'publish' ? pushing({ op: 'sync' }, r.sync.kind === 'push' ? `Push ${plural(r.ahead, 'commit')}` : `Publish ${r.branch}`) : run({ op: 'sync' }))
  const canCommit = !busy && !!summary.trim() && checked.length > 0 && !!r.branch
  const toggle = (p: string) => setUnchecked(u => { const n = new Set(u); if (n.has(p)) n.delete(p); else n.add(p); return n })
  const all = checked.length === r.files.length
  const compare = r.github && r.branch && `${r.github}/compare/${encodeURI(t.name)}?expand=1`
  const head = r.log[0]
  const createPr = r.github && r.upstream && !MAIN.test(t.name) && (isVSCode
    ? <button type="button" className="hub-btn" style={small} disabled={busy} onClick={() => run({ op: 'pr' })} title="gh pr create --fill --web, or the compare page">Create pull request</button>
    : compare && <a className="hub-btn" style={{ ...small, textDecoration: 'none' }} href={compare} target="_blank" rel="noopener noreferrer">Create pull request ↗</a>)
  // The chat itself merges and fixes; a chat that cannot take a message gets a new one in its folder.
  const resolve = () => {
    if (!r.merge || !chat) return
    const text = resolvePrompt(r.merge)
    send(boxNote(chat) ? { type: 'hub-new-chat', path: chat.cwd, text, remote: false } : { type: 'hub-send', sessionId, text })
  }

  return (
    <section aria-label="Git" aria-busy={busy} style={panel}>
      <h3 style={caps}>
        <span>Git · {r.name}</span>
        {r.github && <button type="button" className="hub-link" style={{ padding: '2px 4px', font: 'inherit', textTransform: 'none' }}
          onClick={() => open(r.branch && r.upstream ? `${r.github}/tree/${encodeURI(t.name)}` : r.github!)}>Open on GitHub ↗</button>}
      </h3>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <button type="button" className="hub-btn" style={{ ...small, fontFamily: 'var(--hub-mono)', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          aria-expanded={menu} aria-haspopup="true" onClick={() => setMenu(!menu)} title="Switch, create or delete a branch">
          {r.branch ?? 'detached HEAD'} ▾
        </button>
        <span style={{ font: '400 12px/1 var(--hub-mono)', color: 'var(--hub-ash)' }}
          title={r.upstream ? `Against ${r.upstream}` : 'No upstream yet'}>{r.upstream ? `↑${r.ahead} ↓${r.behind}` : 'not published'}</span>
        <button type="button" className="hub-btn" style={{ ...small, marginLeft: 'auto' }} disabled={busy || !r.branch} onClick={sync}
          title={r.sync.kind === 'publish' ? `git push -u origin ${r.branch}` : `git ${r.sync.kind}`}>{r.busy === 'sync' ? 'Working...' : r.sync.label}</button>
      </div>

      {menu && <div role="group" aria-label="Branches" style={{ display: 'grid', gap: 6, padding: 10, borderRadius: 8, border: '1px solid var(--hub-hair)', background: 'var(--hub-canvas)' }}>
        <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2, maxHeight: 220, overflowY: 'auto' }}>
          {r.branches.map(b => {
            const here = b === r.branch
            return <li key={b} style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
              <button type="button" className="hub-link" disabled={busy} aria-current={here || undefined}
                onClick={() => { setMenu(false); if (here) return; if (r.files.length) setAsk({ text: `Stash ${plural(r.files.length, 'changed file')} and switch to ${b}? Pop stash brings them back.`, yes: 'Stash and switch', cmd: { op: 'switch', branch: b, stash: true } }); else run({ op: 'switch', branch: b }) }}
                title={here ? 'Current branch' : `git switch ${b}`}
                style={{ flex: 1, minWidth: 0, textAlign: 'left', font: '400 12px/1.3 var(--hub-mono)', color: here ? 'var(--hub-ink)' : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {here ? '● ' : ''}{b}
              </button>
              {!here && !MAIN.test(b) && <button type="button" className="hub-link" aria-label={`Delete ${b}`} disabled={busy}
                onClick={() => setAsk({ text: `Delete the local branch ${b}? git keeps it if it has unmerged commits.`, yes: 'Delete', cmd: { op: 'delete-branch', branch: b, confirmed: true } })}>✕</button>}
            </li>
          })}
        </ul>
        <form style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} onSubmit={e => { e.preventDefault(); if (newBranch.trim()) { run({ op: 'create', branch: newBranch.trim() }); setNewBranch(''); setMenu(false) } }}>
          <input aria-label="New branch name" placeholder="new-branch-name" value={newBranch} onChange={e => setNewBranch(e.target.value)} style={{ ...field, flex: '1 1 140px', fontFamily: 'var(--hub-mono)', fontSize: 12 }} />
          <button type="submit" className="hub-btn" style={small} disabled={busy || !newBranch.trim()}>New branch</button>
        </form>
      </div>}

      {r.merge
        ? <PrCard repo={r} create={createPr} busy={busy || !chat} onOpen={open} onResolve={resolve} />
        : <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12 }}>
            {r.pr
              ? <button type="button" className="hub-link" style={{ padding: '2px 0', fontSize: 12, textAlign: 'left' }} onClick={() => open(r.pr!.url)}>
                  PR {r.pr.state.toLowerCase()}: {r.pr.title} ↗
                </button>
              : createPr}
          </div>}

      {r.ci && <CiCard run={r.ci} busy={busy} onOpen={() => open(r.ci!.url)} onRerun={() => run({ op: 'rerun' })} />}

      {r.files.length > 0
        ? <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--hub-ash)' }}>
              <input type="checkbox" checked={all} ref={el => { if (el) el.indeterminate = !all && checked.length > 0 }}
                onChange={() => setUnchecked(all ? new Set(r.files.map(f => f.path)) : new Set())} />
              {checked.length} of {plural(r.files.length, 'file')} checked
            </label>
            <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 0, maxHeight: 260, overflowY: 'auto', border: '1px solid var(--hub-hair)', borderRadius: 6 }}>
              {r.files.map(f => (
                <li key={f.path}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', minHeight: 30, cursor: 'pointer' }} title={f.from ? `${f.from} → ${f.path}` : f.path}>
                    <input type="checkbox" checked={!unchecked.has(f.path)} onChange={() => toggle(f.path)} />
                    <span style={{ flex: 1, minWidth: 0, font: '400 12px/1.4 var(--hub-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}><bdi>{f.path}</bdi></span>
                    <span aria-label={f.status} style={{ font: '500 11px/1 var(--hub-mono)', color: f.status === 'deleted' || f.status === 'conflict' ? 'var(--hub-red)' : f.status === 'modified' || f.status === 'renamed' ? 'var(--hub-yellow)' : 'var(--hub-green)' }}>{TAG[f.status]}</span>
                  </label>
                </li>
              ))}
            </ul>
            <input aria-label="Commit summary" placeholder="Summary (required)" value={summary} onChange={e => { setSummary(e.target.value); setTyped(true) }} style={{ ...field, fontWeight: 500 }} />
            <textarea aria-label="Commit description" placeholder="Description: what this commit did, one bullet per line" rows={Math.min(12, Math.max(3, description.split('\n').length + 1))} value={description} onChange={e => { setDescription(e.target.value); setTyped(true) }} style={{ ...field, resize: 'vertical' }} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button type="button" className="hub-btn primary" style={{ ...small, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} disabled={!canCommit}
                onClick={() => run({ op: 'commit', files: checked, summary, description })}>{r.busy === 'commit' ? 'Committing...' : `Commit to ${r.branch ?? 'branch'}`}</button>
              <button type="button" className="hub-btn" style={small} disabled={!canCommit}
                onClick={() => pushing({ op: 'commit-push', files: checked, summary, description }, `Commit ${plural(checked.length, 'file')} and push`)}>{r.busy === 'commit-push' ? 'Working...' : 'Commit & push'}</button>
            </div>
          </>
        : <p style={{ margin: 0, fontSize: 13, color: 'var(--hub-ash)' }}>Nothing to commit.</p>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, marginLeft: -8 }}>
        {head && (!r.upstream || r.ahead > 0) && <button type="button" className="hub-link" disabled={busy} title="git reset --soft HEAD~1: the commit's changes stay, staged"
          onClick={() => setAsk({ text: `Undo the last commit, "${head.subject}"? Its changes stay as staged files.`, yes: 'Undo', cmd: { op: 'undo', confirmed: true } })}>Undo last commit</button>}
        {r.files.length > 0 && <button type="button" className="hub-link" disabled={busy} onClick={() => run({ op: 'stash' })} title="git stash push -u">Stash</button>}
        {r.stashes > 0 && <button type="button" className="hub-link" disabled={busy} onClick={() => run({ op: 'pop' })} title="git stash pop">Pop stash ({r.stashes})</button>}
        {checked.length > 0 && <button type="button" className="hub-link" disabled={busy} style={{ color: 'var(--hub-red)' }}
          onClick={() => setAsk({ text: `Discard the changes in ${plural(checked.length, 'checked file')}? New files are deleted. This cannot be undone.`, yes: 'Discard', cmd: { op: 'discard', files: checked, confirmed: true } })}>Discard checked ({checked.length})</button>}
      </div>

      {ask && <div role="alertdialog" aria-label="Confirm" style={{ display: 'grid', gap: 8, padding: 10, borderRadius: 8, border: '1px solid var(--hub-red)', background: 'var(--hub-red-soft)', color: 'var(--hub-ink)', fontSize: 13 }}>
        <span>{ask.text}</span>
        <span style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="hub-btn primary" style={small} autoFocus onClick={() => run(ask.cmd)}>{ask.yes}</button>
          <button type="button" className="hub-btn" style={small} onClick={() => setAsk(null)}>Cancel</button>
        </span>
      </div>}

      <p aria-live="polite" style={{ margin: 0, fontSize: 12, minHeight: 0, color: r.result?.ok === false ? 'var(--hub-red)' : 'var(--hub-mute)' }}>
        {r.busy ? 'Running git...' : r.result?.text ?? ''}
      </p>

      {r.log.length > 0 && <details>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--hub-mute)', padding: '4px 0' }}>Recent commits</summary>
        <ol role="list" style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gap: 2 }}>
          {r.log.map(l => <li key={l.hash} style={{ display: 'flex', gap: 8, fontSize: 12, minWidth: 0 }}>
            <code style={{ font: '400 12px/1.5 var(--hub-mono)', color: 'var(--hub-ash)' }}>{l.hash}</code>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--hub-body)' }}>{l.subject}</span>
            <span style={{ color: 'var(--hub-ash)', whiteSpace: 'nowrap' }}>{l.when}</span>
          </li>)}
        </ol>
      </details>}
    </section>
  )
}
