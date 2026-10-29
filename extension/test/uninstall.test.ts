/**
 * Runs the vscode:uninstall script against a sandboxed HOME and checks it
 * removes only Switchboard's hooks and folder, never Agent Flow's.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

const SCRIPT = path.join(__dirname, '..', 'scripts', 'uninstall.js')

describe('uninstall script', { skip: process.platform === 'win32' && 'HOME override is POSIX-only' }, () => {
  it("removes Switchboard's hooks and keeps Agent Flow's and other tools'", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-uninstall-'))
    const settingsPath = path.join(home, '.claude', 'settings.json')
    const foreign = { hooks: [{ type: 'http', url: 'http://127.0.0.1:19847/hook/9207692e/stop' }] }
    const agentFlow = { hooks: [{ type: 'command', command: `"node" "${home}/.claude/agent-flow/hook.js"` }] }
    fs.mkdirSync(path.join(home, '.claude', 'switchboard'), { recursive: true })
    fs.mkdirSync(path.join(home, '.claude', 'agent-flow'), { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({
      model: 'opus',
      hooks: {
        Stop: [foreign, agentFlow, { hooks: [{ type: 'command', command: `"node" "${home}/.claude/switchboard/hook.js"` }] }],
        SessionStart: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:52341' }] }],
      },
    }))

    execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, HOME: home } })

    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')), {
      model: 'opus',
      hooks: { Stop: [foreign, agentFlow] },
    })
    assert.equal(fs.existsSync(path.join(home, '.claude', 'switchboard')), false)
    assert.equal(fs.existsSync(path.join(home, '.claude', 'agent-flow')), true)
  })
})
