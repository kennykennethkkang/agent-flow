/**
 * Whether each thing Kenneth asked a chat for shows up as done, judged by Jev from the chat's own Done and Left lists.
 * Runs only when the claude-x-jev skill is installed; its key comes from Kenneth's shell, so a login shell runs it.
 */
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ChatProgress } from './types'

const JEV = path.join(os.homedir(), '.claude', 'skills', 'claude-x-jev', 'scripts', 'jev.py')
const PRESET = {
  name: 'switchboard-request-done', version: 1, model: 'typesafe/jev-1.13',
  description: "Was one of Kenneth's requests to a chat carried out, judging by the chat's final Done and Left lists",
  state_fields: ['request', 'done', 'left'], display_fields: ['_id'],
  questions: { addressed: { type: 'noul', instructions: 'Does `done` show that `request` was carried out or answered? A request that only shows up in `left` was not.' } },
  thresholds: { addressed: { low: 0.2, high: 0.8 } }, rules: [],
}

/** The items Jev scores, one per request. */
export const coverageItems = (p: ChatProgress) => (p.asked ?? []).map((request, i) => ({
  _id: String(i), request, done: (p.report?.done.length ? p.report.done : p.tasks.filter(t => t.status === 'completed').map(t => t.subject)).join('\n'), left: (p.report?.left ?? []).join('\n'),
}))

/** One score per jev.py output line, by _id; undefined for a request it did not answer. */
export function parseScores(out: string, n: number): Array<number | null> {
  const scores: Array<number | null> = Array(n).fill(null)
  for (const line of out.split('\n')) {
    try {
      const r = JSON.parse(line) as { _id?: string; addressed?: unknown }
      const i = Number(r._id)
      if (Number.isInteger(i) && i >= 0 && i < n && typeof r.addressed === 'number') scores[i] = r.addressed
    } catch { /* the summary line or noise */ }
  }
  return scores
}

/** Scores for p's requests, or undefined when Jev is missing, fails or there is nothing to check. */
export async function checkAsked(p: ChatProgress): Promise<Array<number | null> | undefined> {
  const items = coverageItems(p)
  if (!items.length || !fs.existsSync(JEV)) return undefined
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-jev-'))
  try {
    const preset = path.join(dir, 'preset.json'), input = path.join(dir, 'items.json')
    fs.writeFileSync(preset, JSON.stringify(PRESET))
    fs.writeFileSync(input, JSON.stringify(items))
    // Paths go in as $0..$2, never into the command text.
    const out = await new Promise<string | undefined>(done => execFile('/bin/zsh', ['-ic', 'python3 "$0" ask --preset "$1" --input "$2"', JEV, preset, input],
      { timeout: 20_000, maxBuffer: 1 << 20 }, (err, stdout) => done(err ? undefined : String(stdout))))
    return out === undefined ? undefined : parseScores(out, items.length)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
