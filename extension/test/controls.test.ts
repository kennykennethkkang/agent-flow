/**
 * Unit tests for the Controls whitelist: the only Claude Code settings
 * Switchboard may write, and the values each may take.
 *
 * The invariant: env, permissions and hooks are never written from a switch.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyPatch, controlPatch, readControls } from '../src/hub/controls'

const LINE = 'node "/k/claude-mods/kit/statusline.mjs"'

describe('controlPatch', () => {
  it('takes booleans for the on/off settings only', () => {
    for (const key of ['autoCompactEnabled', 'autoContinueAtUsageLimit', 'remoteControlAtStartup', 'agentPushNotifEnabled', 'inputNeededNotifEnabled']) {
      assert.deepEqual(controlPatch(key, false), { [key]: false })
      assert.equal(controlPatch(key, 'yes'), undefined)
    }
  })

  it('takes only the listed choices, null unsetting the ones that have a default', () => {
    assert.deepEqual(controlPatch('autoCompactWindow', 400000), { autoCompactWindow: 400000 })
    assert.equal(controlPatch('autoCompactWindow', 12345), undefined)
    assert.deepEqual(controlPatch('model', 'sonnet'), { model: 'sonnet' })
    assert.deepEqual(controlPatch('model', null), { model: null })
    assert.equal(controlPatch('model', 'gpt-5'), undefined)
    assert.deepEqual(controlPatch('effortLevel', 'xhigh'), { effortLevel: 'xhigh' })
    assert.deepEqual(controlPatch('effortLevel', null), { effortLevel: null })
    assert.equal(controlPatch('effortLevel', 'auto'), undefined)
    assert.deepEqual(controlPatch('tui', 'default'), { tui: 'default' })
    assert.equal(controlPatch('tui', null), undefined)
  })

  it('takes fable as a model', () => {
    assert.deepEqual(controlPatch('model', 'fable'), { model: 'fable' })
  })

  it('turns the status line on with the kit command and off by unsetting it', () => {
    assert.deepEqual(controlPatch('statusLine', true, LINE), { statusLine: { type: 'command', command: LINE } })
    assert.deepEqual(controlPatch('statusLine', false, LINE), { statusLine: null })
    assert.equal(controlPatch('statusLine', true), undefined)
  })

  it('refuses env, permissions, hooks and anything not listed', () => {
    for (const key of ['env', 'permissions', 'hooks', 'apiKeyHelper', 'toString', '__proto__', 'constructor']) {
      assert.equal(controlPatch(key, true), undefined)
      assert.equal(controlPatch(key, null), undefined)
    }
  })
})

describe('applyPatch', () => {
  it('sets values, removes keys patched to null and keeps everything else', () => {
    const before = { model: 'opus', effortLevel: 'high', env: { A: '1' }, hooks: { Stop: [] } }
    const after = applyPatch(before, { effortLevel: null, model: 'haiku' })
    assert.deepEqual(after, { model: 'haiku', env: { A: '1' }, hooks: { Stop: [] } })
    assert.equal(before.effortLevel, 'high')
  })
})

describe('readControls', () => {
  it('reads what the Controls cards show, with Claude Code defaults when unset', () => {
    assert.deepEqual(readControls({ model: 'opus', tui: 'fullscreen', agentPushNotifEnabled: true, statusLine: { type: 'command', command: LINE } }), {
      model: 'opus', effortLevel: undefined, tui: 'fullscreen', statusLine: true, push: true, needInput: false,
    })
    assert.deepEqual(readControls({ model: 'claude-opus-5-5', effortLevel: 'max' }), {
      model: undefined, effortLevel: 'max', tui: 'default', statusLine: false, push: false, needInput: false,
    })
  })

  it('reads fable back', () => {
    assert.equal(readControls({ model: 'fable' }).model, 'fable')
  })
})
