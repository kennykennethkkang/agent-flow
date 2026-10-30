/** The tests, CI and usage-limit cards' words, from hub data alone. */
import type { CiRun, Limit, TestRun } from './hub-types'

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const FAILED = new Set(['failure', 'timed_out', 'startup_failure'])

export function testsLine(t: TestRun): string {
  const first = t.first ? `, first: ${t.first}` : ''
  if (t.failed && t.total) return `The last test run failed ${t.failed} of ${t.total}${first}.`
  if (t.failed) return `The last test run had ${plural(t.failed, 'failure')}${first}.`
  return `The last test run failed${first}.`
}

/** What Send to chat sends. */
export const testsPrompt = (t: TestRun) => [`The last test run failed: ${t.command}`, ...(t.tail?.length ? [t.tail.join('\n')] : []), 'Fix the failing tests and run them again.'].join('\n\n')

export const ciState = (c: CiRun) => c.status !== 'completed' ? 'running' : FAILED.has(c.conclusion ?? '') ? 'failed' : c.conclusion === 'success' ? 'passed' : 'other'

export function ciLine(c: CiRun): string {
  const on = (verb: string) => `${c.workflow} ${verb} on ${c.sha}`
  const s = ciState(c)
  if (s === 'running') {
    const done = c.jobs.filter(j => j.status === 'completed').length
    return `${on('is running')}${c.jobs.length ? `: ${done} of ${plural(c.jobs.length, 'job')} done` : ''}.`
  }
  if (s === 'passed') return `${on('passed')}, all ${plural(c.jobs.length, 'job')} green.`
  if (s === 'other') return `${on(`ended ${c.conclusion ?? c.status}`)}.`
  const bad = c.jobs.find(j => FAILED.has(j.conclusion ?? ''))
  return bad ? `${on('failed')}: ${bad.name} broke${bad.step ? ` at "${bad.step}"` : ''}. Re-run the failed jobs, or ask the chat to fix it.` : `${on('failed')}.`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const hhmm = (d: Date) => d.toTimeString().slice(0, 5)

/** When the used-up limit resets, and who continues the chat then (hub-service.ts retries unless Claude Code's own auto-continue is on). */
export function limitLine(limits: Limit[], autoContinue: boolean, now = Date.now()): string {
  const at = Math.max(...limits.filter(l => l.percentUsed >= 100).map(l => Date.parse(l.resetsAt ?? '')).filter(Number.isFinite))
  const d = new Date(at), today = Number.isFinite(at) && d.toDateString() === new Date(now).toDateString()
  const when = Number.isFinite(at) ? `Resets ${today ? 'at' : DAYS[d.getDay()]} ${hhmm(d)}. ` : ''
  return when + (autoContinue ? 'Auto-continue is on, so Claude Code picks it up then.' : `Auto-continue is off; Switchboard sends it again a minute after${when ? '' : ' the reset'}.`)
}
