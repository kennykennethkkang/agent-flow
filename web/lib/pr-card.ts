/** The PR card's words, from RepoView alone. */
import type { RepoView } from './hub-types'

type R = Pick<RepoView, 'pr' | 'merge'>
type Merge = NonNullable<RepoView['merge']>

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)
const base = (p: string) => p.split('/').pop() ?? p

/** One plain paragraph under the card. */
export function summary({ pr, merge: m }: R): string {
  if (!m) return ''
  const lead = pr?.number ? `PR #${pr.number} is ${pr.state.toLowerCase()}` : 'This branch'
  const cs = m.conflicts ?? []
  if (m.files && cs.length) {
    const who = list([...new Set(cs.map(c => c.by))])
    const more = m.files - cs.length
    const files = more > 0 ? `${cs.map(c => base(c.path)).join(', ')} and ${more} more` : list(cs.map(c => base(c.path)))
    return `${pr?.number ? `${lead}, but ` : ''}${m.base} moved on while we worked: ${who} changed the same lines in ${files}. I can merge ${m.base} and resolve them.`
  }
  if (!m.behind) return `${lead} is up to date with ${m.base}.`
  // No conflicts list: git is too old to check, so say nothing about it.
  const clean = !!m.conflicts
  if (pr?.number) return `${lead}. ${m.base} has ${plural(m.behind, 'new commit')}${clean ? ', and they merge cleanly' : ''}.`
  return `${lead} is behind ${m.base} by ${plural(m.behind, 'commit')}${clean ? ', and it merges cleanly' : ''}.`
}

/** What Resolve conflicts sends the chat. */
export const resolvePrompt = (m: Merge) =>
  `Merge ${m.base} into this branch and resolve the conflicts in ${(m.conflicts ?? []).map(c => c.path).join(', ')}${m.files > (m.conflicts?.length ?? 0) ? ` and ${m.files - (m.conflicts?.length ?? 0)} more` : ''}. Keep both intents where possible, run the tests, and do not commit.`

/** #128 · 3 conflicts · +482 −37 */
export function pill({ pr, merge: m }: R): string {
  const parts = [pr?.number ? `#${pr.number}` : '', m?.files ? plural(m.files, 'conflict') : '', pr?.number ? `+${pr.additions ?? 0} −${pr.deletions ?? 0}` : '']
  return parts.filter(Boolean).join(' · ') || 'No PR yet'
}

/** now, 6m, 2h, 3d */
export function short(at: number, now = Date.now()): string {
  const m = Math.floor((now - at) / 60e3)
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
}
