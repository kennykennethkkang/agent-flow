/**
 * The AI registry: a Codex rollout read as a chat row, and each AI's start and resume commands.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AIS, chatTerminal, closeChatTerminal, codexPaste, codexReady, codexRow, isCodexCommand, lastCodexPrompt, rolloutLines } from '../src/hub/ais'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'c0de', cwd: '/u/GitHub/Armasu' } })
const ask = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Fix the closet regen button please' } })

describe('ais', () => {
  it('reads a Codex rollout as a chat row named by its first message', () => {
    const now = 1_000_000_000
    const row = codexRow([meta, ask], now - 60_000, now)
    assert.equal(row?.ai, 'codex')
    assert.equal(row?.sessionId, 'c0de')
    assert.equal(row?.cwd, '/u/GitHub/Armasu')
    assert.equal(row?.name, 'Fix the closet regen button please')
    assert.equal(row?.live, true)
    assert.equal(codexRow([meta, ask], now - 3_600_000, now)?.live, false)
  })

  it('reads the context fill from the last token count', () => {
    const tokens = (n: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: n }, model_context_window: 200_000 } } })
    assert.equal(codexRow([meta, ask, tokens(50_000), tokens(180_000)], 0, 0)?.fill, 0.9)
    assert.equal(codexRow([meta, ask], 0, 0)?.fill, undefined)
  })

  it('names a handed-off Codex chat from its note', () => {
    const cont = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Brief\n\nContinue from /h/Armasu/n-c0de.md: read it first' } })
    const read = (p: string) => (p === '/h/Armasu/n-c0de.md' ? '# Handoff 2 · Armasu · continued\nFrom: x (c0de)\nTo:   Armasu · continued · 2\n' : undefined)
    const row = codexRow([meta, cont], 0, 0, read)
    assert.equal(row?.name, 'Armasu · continued · 2')
  })

  it('names a handed-off Codex chat when the note path has a space', () => {
    const cont = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Continue from /h/My Proj/n-c0de.md: read it first, then carry on.' } })
    const read = (p: string) => (p === '/h/My Proj/n-c0de.md' ? '# Handoff 2 · My Proj\nTo:   My Proj v2\n' : undefined)
    assert.equal(codexRow([meta, cont], 0, 0, read)?.name, 'My Proj v2')
  })

  it('never names a Codex chat from the Switchboard brief in front of its first message', () => {
    const brief = 'Switchboard brief for Armasu. Ask the hub_ask tool for more.\nDev site: http://localhost:3010'
    const msg = (m: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: m } })
    assert.equal(codexRow([meta, msg(`${brief}\n\nFix the login bug`)], 0, 0)?.name, 'Fix the login bug')
    assert.equal(codexRow([meta, msg(brief)], 0, 0)?.name, undefined)
  })

  it('reads whether the last Codex turn ended: idle after task_complete or turn_aborted, busy after task_started, unknown without either', () => {
    const ev = (type: string) => JSON.stringify({ type: 'event_msg', payload: { type } })
    assert.equal(codexRow([meta, ask, ev('task_started'), ev('agent_message'), ev('task_complete')], 0, 0)?.status, 'idle')
    assert.equal(codexRow([meta, ask, ev('task_started'), ev('turn_aborted')], 0, 0)?.status, 'idle')
    assert.equal(codexRow([meta, ask, ev('task_complete'), ev('task_started'), ev('agent_message')], 0, 0)?.status, 'busy')
    assert.equal(codexRow([meta, ask, ev('agent_message')], 0, 0)?.status, undefined)
  })

  it('finds the last prompt', () => {
    const later = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'now the doors' } })
    assert.equal(lastCodexPrompt([meta, ask, later]), 'now the doors')
  })

  it('skips a file without session_meta', () => {
    assert.equal(codexRow([ask], 0, 0), undefined)
  })

  it('starts and resumes each AI with its own CLI', () => {
    assert.equal(AIS.codex.startCommand({ text: "it's" }, 'posix'), `codex 'it'\\''s'`)
    assert.equal(AIS.codex.startCommand({ text: 'it\u2019s' }, 'powershell'), "codex 'it\u2019\u2019s'")
    assert.equal(AIS.codex.resumeCommand('abc'), 'codex resume abc')
    assert.equal(AIS.claude.resumeCommand('abc'), 'claude --resume abc')
    assert.equal(AIS.claude.startCommand({ name: 'x' }, 'posix'), `claude --name 'x'`)
  })
})

it('reads an unchanged rollout once: the same mtime returns the lines it read before', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-')), 'r.jsonl')
  fs.writeFileSync(file, 'one\n')
  assert.deepEqual(await rolloutLines(file, 1), ['one', ''])
  fs.writeFileSync(file, 'two\n')
  assert.deepEqual(await rolloutLines(file, 1), ['one', ''])
  assert.deepEqual(await rolloutLines(file, 2), ['two', ''])
  assert.deepEqual(await rolloutLines(file), ['two', ''])
})

it('wraps a Codex message in one bracketed paste, and refuses one with control characters', () => {
  assert.equal(codexPaste('fix it\n\tthen test'), '\x1b[200~fix it\n\tthen test\x1b[201~')
  assert.equal(codexPaste('a\x1b[201~b'), undefined)
  assert.equal(codexPaste('a\rb'), undefined)
})

it('knows a Codex process from a shell by its command line', () => {
  assert.equal(isCodexCommand('node /opt/homebrew/bin/codex resume abc'), true)
  assert.equal(isCodexCommand('/Users/k/.local/bin/codex'), true)
  assert.equal(isCodexCommand('-zsh'), false)
  assert.equal(isCodexCommand('/bin/zsh -il'), false)
  assert.equal(isCodexCommand("/bin/zsh -c codex resume abc"), false)
  assert.equal(isCodexCommand('bash /opt/homebrew/bin/codex'), false)
  assert.equal(isCodexCommand(''), false)
})

describe('codexReady', () => {
  const term = (pid?: number, exited = false) => ({ processId: Promise.resolve(pid), exitStatus: exited ? { code: 0 } : undefined })
  const ps = (cmd: string) => async () => cmd
  const base = { live: true, startedAt: 0, now: 10_000 }
  it('passes a live chat whose terminal process is codex', async () => {
    assert.equal(await codexReady({ ...base, terminal: term(42) }, ps('node /opt/homebrew/bin/codex')), undefined)
  })
  it('refuses a terminal whose process is not codex, so a shell never gets the text', async () => {
    assert.match((await codexReady({ ...base, terminal: term(42) }, ps('-zsh')))!, /not running Codex/)
  })
  it('refuses a missing or ended terminal, a chat that is not live, and one still starting', async () => {
    assert.ok(await codexReady({ ...base, terminal: undefined }, ps('codex')))
    assert.ok(await codexReady({ ...base, terminal: term(42, true) }, ps('codex')))
    assert.ok(await codexReady({ ...base, terminal: term(undefined) }, ps('codex')))
    assert.ok(await codexReady({ ...base, live: false, terminal: term(42) }, ps('codex')))
    assert.match((await codexReady({ ...base, startedAt: 9_000, terminal: term(42) }, ps('codex')))!, /starting/)
  })
})

describe('closeChatTerminal', () => {
  const term = (pid: number) => { const t = { processId: Promise.resolve(pid), disposed: false, dispose() { t.disposed = true } }; return t }
  const opts = (ppid: number, aliveFor: number) => { let n = 0; return { parent: async () => ppid, alive: () => n++ < aliveFor, waitMs: 50, stepMs: 1 } }

  it('disposes the terminal whose shell started the chat, once the chat has exited', async () => {
    const shell = term(10), other = term(11)
    assert.equal(await closeChatTerminal(99, [other, shell], opts(10, 3)), true)
    assert.equal(shell.disposed, true)
    assert.equal(other.disposed, false)
  })

  it('leaves terminals alone when no shell of theirs started the chat', async () => {
    const t = term(10)
    assert.equal(await closeChatTerminal(99, [t], opts(7, 0)), false)
    assert.equal(t.disposed, false)
  })

  it('leaves the terminal open when the chat never exits', async () => {
    const t = term(10)
    assert.equal(await closeChatTerminal(99, [t], opts(10, Infinity)), false)
    assert.equal(t.disposed, false)
  })
})

describe('chatTerminal', () => {
  it('finds the terminal whose shell started the chat, and none when no shell did', async () => {
    const terms = [{ processId: Promise.resolve(10) }, { processId: Promise.resolve(11) }]
    assert.equal(await chatTerminal(99, terms, async () => 11), terms[1])
    assert.equal(await chatTerminal(99, terms, async () => 7), undefined)
    assert.equal(await chatTerminal(99, terms, async () => 0), undefined)
  })
})
