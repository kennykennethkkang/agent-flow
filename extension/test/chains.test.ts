/**
 * Handoff chains: which chain each handed-off chat belongs to, kept in chains.json.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { dueForHandoff, idleHandedOff, matchCodexStarts, readArchive, readChains, recordArchive, recordChain, removeArchive, withChains } from '../src/hub/chains'

describe('chains', () => {
  it('records each old chat under its chain and reads them back', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chains-')), 'chains.json')
    assert.deepEqual(readChains(file), {})
    recordChain('a', 'Armasu · continued', file)
    recordChain('b', 'Armasu · continued', file)
    assert.deepEqual(readChains(file), { a: 'Armasu · continued', b: 'Armasu · continued' })
    fs.writeFileSync(file, '[1]')
    assert.deepEqual(readChains(file), {})
  })

  it('puts a row in the chain its name says, else the one it was recorded in', () => {
    const rows = [{ sessionId: 'a', name: 'Fix closet' }, { sessionId: 'b', name: 'Armasu · continued · 2' }, { sessionId: 'c' }, { sessionId: 'd', name: 'Fix closet v2' }]
    assert.deepEqual(withChains(rows, { a: 'Fix closet' }).map(r => r.chain), ['Fix closet', 'Armasu · continued', undefined, 'Fix closet'])
  })

  it('hands off a recent full Codex chat in this window once', () => {
    const now = 1_000_000_000
    const row = (sessionId: string, o: object) => ({ pid: 0, sessionId, cwd: '/u/Armasu/app', link: '', live: true, why: [], ai: 'codex' as const, fill: 0.95, updatedAt: now - 60_000, ...o })
    const chats = [row('due', {}), row('low', { fill: 0.5 }), row('old', { updatedAt: now - 3_600_000 }), row('done', {}), row('else', { cwd: '/u/other' }), row('claude', { ai: 'claude' })]
    assert.deepEqual(dueForHandoff(chats, new Set(['done']), '/u/Armasu', now).map(c => c.sessionId), ['due'])
  })

  it('waits while a full Codex chat still has an open turn, for at most 30 minutes', () => {
    const now = 1_000_000_000
    const busy = { pid: 0, sessionId: 'busy', cwd: '/u/Armasu', link: '', live: true, why: [], ai: 'codex' as const, fill: 0.95, updatedAt: now - 1000, status: 'busy' }
    const since = new Map<string, number>()
    assert.deepEqual(dueForHandoff([busy], new Set(), '/u/Armasu', now, since), [])
    assert.equal(since.get('busy'), now)
    assert.deepEqual(dueForHandoff([{ ...busy, updatedAt: now + 29 * 60_000 }], new Set(), '/u/Armasu', now + 29 * 60_000, since), [])
    assert.deepEqual(dueForHandoff([{ ...busy, updatedAt: now + 30 * 60_000 }], new Set(), '/u/Armasu', now + 30 * 60_000, since).length, 1)
    assert.deepEqual(dueForHandoff([{ ...busy, status: 'idle' }], new Set(), '/u/Armasu', now).length, 1)
  })

  it('archives each closed chat once, newest last, and reads back only well formed rows', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'archive-')), 'archive.json')
    assert.deepEqual(readArchive(file), [])
    const row = { sessionId: 'a', ai: 'claude' as const, name: 'Fix login redirect', origin: 'Fix login redirect', version: 1, cwd: '/u/Armasu', project: 'Armasu', note: '/h/1.md', archivedAt: 10 }
    recordArchive(row, file)
    recordArchive({ ...row, sessionId: 'b', name: 'Fix login redirect v2', version: 2, archivedAt: 20 }, file)
    recordArchive({ ...row, archivedAt: 30 }, file)
    assert.deepEqual(readArchive(file).map(r => [r.sessionId, r.archivedAt]), [['b', 20], ['a', 30]])
    fs.writeFileSync(file, JSON.stringify([{ sessionId: 'x' }, row, 'junk']))
    assert.deepEqual(readArchive(file), [row])
    fs.writeFileSync(file, '{')
    assert.deepEqual(readArchive(file), [])
  })

  it('closes a handed-off Codex chat only after its turn ended and two quiet minutes, never when unsure', () => {
    const now = 1_000_000_000
    const row = (sessionId: string, updatedAt: number, status?: string) => ({ pid: 0, sessionId, cwd: '/u/Armasu', link: '', live: true, why: [], ai: 'codex' as const, updatedAt, status })
    // A five-minute gap mid-turn (reasoning, then a tool call) is still busy.
    const chats = [row('idle', now - 121_000, 'idle'), row('fresh', now - 30_000, 'idle'), row('midturn', now - 300_000, 'busy'), row('unknown', now - 600_000), row('other', now - 600_000, 'idle')]
    assert.deepEqual(idleHandedOff(chats, new Set(['idle', 'fresh', 'midturn', 'unknown']), now).map(c => c.sessionId), ['idle'])
  })

  it('backs up an unreadable archive before writing over it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-bad-'))
    const file = path.join(dir, 'archive.json')
    fs.writeFileSync(file, '[{"sessionId":"a",')
    const row = { sessionId: 'z', ai: 'claude' as const, name: 'n', origin: 'n', version: 1, cwd: '/u', project: 'u', archivedAt: 1 }
    recordArchive(row, file)
    const bad = fs.readdirSync(dir).filter(n => n.startsWith('archive.json.bad-'))
    assert.equal(bad.length, 1)
    assert.equal(fs.readFileSync(path.join(dir, bad[0]), 'utf8'), '[{"sessionId":"a",')
    assert.deepEqual(readArchive(file).map(r => r.sessionId), ['z'])
  })

  it('takes a resumed chat out of the archive', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'archive-rm-')), 'archive.json')
    const row = { sessionId: 'a', ai: 'claude' as const, name: 'n', origin: 'n', version: 1, cwd: '/u', project: 'u', archivedAt: 1 }
    recordArchive(row, file)
    recordArchive({ ...row, sessionId: 'b' }, file)
    assert.equal(removeArchive('a', file), true)
    assert.deepEqual(readArchive(file).map(r => r.sessionId), ['b'])
    assert.equal(removeArchive('nope', file), false)
  })

  it('ties a Codex terminal to its session only when exactly one new rollout fits', () => {
    const row = (sessionId: string, cwd: string, name: string, updatedAt: number) => ({ pid: 0, sessionId, cwd, name, link: '', live: true, why: [], ai: 'codex' as const, updatedAt })
    const starts = [{ key: 't1', cwd: '/u/a', name: 'Fix login', at: 100 }, { key: 't2', cwd: '/u/a', name: 'Same', at: 100 }]
    const chats = [row('s-old', '/u/a', 'Fix login', 50), row('s1', '/u/a', 'Fix login', 150), row('s2', '/u/a', 'Same', 150), row('s3', '/u/a', 'Same', 160), row('s4', '/u/b', 'Fix login', 150)]
    assert.deepEqual([...matchCodexStarts(starts, chats, new Set())], [['t1', 's1']])
    assert.deepEqual([...matchCodexStarts(starts, chats, new Set(['s1']))], [])
  })
})
