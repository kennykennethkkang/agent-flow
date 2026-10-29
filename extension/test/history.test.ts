/**
 * Unit tests for the Hub's usage history.
 *
 * The invariant: each transcript line is counted once, however many scans
 * run, and a scan after new lines reads only what was added.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { HistoryScanner, dayKey } from '../src/hub/history'

const at = (iso: string) => new Date(iso).getTime()
const usage = (ts: string, sessionId: string, cacheRead: number) => JSON.stringify({
  type: 'assistant', timestamp: ts, sessionId, cwd: '/Users/k/Documents/GitHub/Armasu',
  message: { role: 'assistant', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 100 } },
})
const prompt = (ts: string, sessionId: string, text: string) => JSON.stringify({
  type: 'user', timestamp: ts, sessionId, cwd: '/Users/k/Documents/GitHub/Armasu', message: { role: 'user', content: text },
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-history-'))
  const dir = path.join(root, '-Users-k-Documents-GitHub-Armasu')
  fs.mkdirSync(dir)
  const file = path.join(dir, 's1.jsonl')
  fs.writeFileSync(file, [
    prompt('2026-10-22T10:00:00', 's1', '<command-name>/model</command-name>'),
    prompt('2026-10-22T10:00:05', 's1', 'Set up the hub'),
    usage('2026-10-22T10:00:10', 's1', 1000),
    usage('2026-10-23T09:00:00', 's1', 3000),
  ].join('\n') + '\n')
  return { root, file }
}

describe('history', () => {
  it('sums each day and labels the session by its first real prompt', async () => {
    const { root } = fixture()
    const scan = await new HistoryScanner(root).scan(at('2026-10-23T12:00:00'))
    const byDay = Object.fromEntries(scan.history.map(d => [d.day, d]))
    assert.equal(byDay[dayKey(at('2026-10-22T10:00:10'))].reread, 1000)
    assert.equal(byDay[dayKey(at('2026-10-23T09:00:00'))].reread, 3000)
    assert.equal(byDay[dayKey(at('2026-10-23T09:00:00'))].io, 15)
    assert.equal(scan.sessions.length, 1)
    assert.equal(scan.sessions[0].label, 'Set up the hub')
    assert.equal(scan.sessions[0].project, 'Armasu')
    assert.equal(scan.sessions[0].reread, 4000)
    assert.equal(scan.sessions[0].calls, 2)
  })

  it('counts appended lines once and nothing twice', async () => {
    const { root, file } = fixture()
    const scanner = new HistoryScanner(root)
    await scanner.scan(at('2026-10-23T12:00:00'))
    fs.appendFileSync(file, usage('2026-10-23T09:30:00', 's1', 500) + '\n')
    const again = await scanner.scan(at('2026-10-23T12:00:00'))
    assert.equal(again.sessions[0].reread, 4500)
    assert.equal(again.sessions[0].calls, 3)
  })

  it("names a chat by its custom title, else by a slash command's arguments", async () => {
    const { root, file } = fixture()
    const other = path.join(path.dirname(file), 's2.jsonl')
    fs.writeFileSync(other, [
      prompt('2026-10-23T08:00:00', 's2', '<command-message>superpowers:using-superpowers</command-message>\n<command-name>/superpowers:using-superpowers</command-name>\n<command-args>Clean up my files</command-args>'),
      usage('2026-10-23T08:00:05', 's2', 10),
    ].join('\n') + '\n')
    fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: 'Setupfeatures', sessionId: 's1' }) + '\n')
    const scan = await new HistoryScanner(root).scan(at('2026-10-23T12:00:00'))
    const labels = Object.fromEntries(scan.sessions.map(s => [s.sessionId, s.label]))
    assert.equal(labels.s1, 'Setupfeatures')
    assert.equal(labels.s2, 'Clean up my files')
    fs.writeFileSync(path.join(path.dirname(file), 's3.jsonl'), [
      prompt('2026-10-23T08:10:00', 's3', '<pasted_content id="ea2b">\nFix the closet tabs\n</pasted_content>'),
      usage('2026-10-23T08:10:05', 's3', 10),
    ].join('\n') + '\n')
    const third = await new HistoryScanner(root).scan(at('2026-10-23T12:00:00'))
    assert.equal(third.sessions.find(s => s.sessionId === 's3')?.label, 'Pasted: Fix the closet tabs')
  })

  it('keeps fourteen days and every day in them, empty ones too', async () => {
    const { root } = fixture()
    const scan = await new HistoryScanner(root).scan(at('2026-10-23T12:00:00'))
    assert.equal(scan.history.length, 14)
    assert.equal(scan.history[13].day, dayKey(at('2026-10-23T12:00:00')))
  })
})
