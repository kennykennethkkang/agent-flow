/**
 * The session registry as chat rows: connected or not, the link into the
 * Claude app, and each reason a chat may be missing there.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chatRows, newer, RC_NAME, rcPattern, rcServerCommand, rcTargets } from '../src/hub/sessions'

const NOW = 1_800_000_000_000
const base = { pid: 1, sessionId: 's1', cwd: '/u/Armasu', status: 'idle', version: '2.1.310', kind: 'interactive', updatedAt: NOW - 60_000 }

describe('chatRows', () => {
  it('links a connected chat and gives no reason', () => {
    const [row] = chatRows([{ ...base, bridgeSessionId: 'br_1' }], () => true, NOW)
    assert.equal(row.link, 'https://claude.ai/code/br_1')
    assert.deepEqual(row.why, [])
    assert.equal(row.live, true)
  })

  it('names every reason a chat is missing', () => {
    const rows = chatRows([
      { ...base, sessionId: 'a', pid: 2, version: '2.1.300', kind: 'print', updatedAt: NOW - 31 * 60_000 },
      { ...base, sessionId: 'b', pid: 3 },
    ], pid => pid !== 2, NOW)
    const a = rows.find(r => r.sessionId === 'a')!
    assert.deepEqual(a.why, ['not connected', 'process gone', 'quiet for 31 min', 'older Claude Code (2.1.300)', 'not an interactive chat'])
    assert.equal(a.link, 'https://claude.ai/code')
  })

  it('drops rows without a pid or session id', () => {
    assert.equal(chatRows([{ cwd: '/x' }, { pid: 'x', sessionId: 's' }], () => true, NOW).length, 0)
  })
})

describe('newer', () => {
  it('compares versions by number', () => {
    assert.equal(newer('2.1.310', '2.1.99'), true)
    assert.equal(newer('2.1.99', '2.1.310'), false)
    assert.equal(newer('2.1.310', '2.1.310'), false)
  })
})

describe('rcTargets', () => {
  it('asks only live chats that are not connected', () => {
    const rows = chatRows([
      { ...base, sessionId: 'on', bridgeSessionId: 'br' },
      { ...base, sessionId: 'off', pid: 5 },
      { ...base, sessionId: 'dead', pid: 6 },
    ], pid => pid !== 6, NOW)
    assert.deepEqual(rcTargets(rows), ['off'])
  })
})

describe('rcServerCommand', () => {
  it('starts the one machine-wide server, sharing its folder, that never prompts', () => {
    assert.equal(RC_NAME, 'Mac')
    assert.equal(rcServerCommand(), "claude remote-control --name 'Mac' --spawn same-dir --permission-mode bypassPermissions")
    assert.ok(new RegExp(rcPattern(RC_NAME)).test(rcServerCommand().replace(/'/g, '')))
  })
})

describe('rcPattern', () => {
  it('matches the LaunchAgent command for that repo only', () => {
    const re = new RegExp(rcPattern('agent.flow'))
    assert.equal(rcPattern('agent.flow'), 'remote-control --name agent\\.flow( |$)')
    assert.ok(re.test('claude remote-control --name agent.flow --spawn worktree'))
    assert.ok(re.test('claude remote-control --name agent.flow'))
    assert.ok(!re.test('claude remote-control --name agentXflow --spawn worktree'))
    assert.ok(!re.test('claude remote-control --name agent.flow2 --spawn worktree'))
  })
})
