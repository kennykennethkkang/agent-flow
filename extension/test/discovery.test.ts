/**
 * Runs the hook forwarder script against a sandboxed HOME with two live windows
 * that do not contain the chat's folder, and checks which one gets the event.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import { spawn } from 'node:child_process'
import { getHookScriptContent } from '../src/discovery'

// Counts only the owner's post; mirror copies have their own test below.
const listen = (hits: string[], name: string) => new Promise<http.Server>(resolve => {
  const s = http.createServer((req, res) => { if (!req.headers['x-switchboard-mirror']) hits.push(name); req.resume(); req.on('end', () => res.end()) })
  s.listen(0, '127.0.0.1', () => resolve(s))
})

test('a chat no window contains goes to the live window with the lowest pid, not the newest', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-forward-'))
  const dir = path.join(home, '.claude', 'switchboard')
  fs.mkdirSync(dir, { recursive: true })
  const script = path.join(home, 'hook.js')
  fs.writeFileSync(script, getHookScriptContent())

  const hits: string[] = []
  const low = await listen(hits, 'low')
  const high = await listen(hits, 'high')
  const port = (s: http.Server) => (s.address() as { port: number }).port
  const [lowPid, highPid] = [process.pid, process.ppid].sort((a, b) => a - b)
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ pid: lowPid, port: port(low), workspace: '/nowhere/a' }))
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ pid: highPid, port: port(high), workspace: '/nowhere/b' }))
  // The higher pid's file is the newest.
  fs.utimesSync(path.join(dir, 'a.json'), new Date(1000), new Date(1000))

  try {
    const child = spawn(process.execPath, [script], { env: { ...process.env, HOME: home, USERPROFILE: home } })
    child.stdin.end(JSON.stringify({ cwd: home, session_id: 's', hook_event_name: 'Stop' }))
    await new Promise(resolve => child.on('exit', resolve))
    assert.deepEqual(hits, ['low'])
  } finally {
    low.close()
    high.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

const run = (payload: object) => new Promise<string>(resolve => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-allow-'))
  const script = path.join(home, 'hook.js')
  fs.writeFileSync(script, getHookScriptContent())
  const child = spawn(process.execPath, [script], { env: { ...process.env, HOME: home, USERPROFILE: home } })
  let out = ''
  child.stdout.on('data', c => { out += c })
  child.on('exit', () => { fs.rmSync(home, { recursive: true, force: true }); resolve(out) })
  child.stdin.end(JSON.stringify(payload))
})

test('Bash runs without a permission prompt; other tools and events print nothing', async () => {
  const bash = JSON.parse(await run({ cwd: os.tmpdir(), session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }))
  assert.equal(bash.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(bash.hookSpecificOutput.permissionDecision, 'allow')
  assert.equal(await run({ cwd: os.tmpdir(), session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Write' }), '')
  assert.equal(await run({ cwd: os.tmpdir(), session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Bash' }), '')
})

test('the owning window gets the event plain, every other live window gets it marked as a mirror', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mirror-'))
  const dir = path.join(home, '.claude', 'switchboard')
  fs.mkdirSync(dir, { recursive: true })
  const script = path.join(home, 'hook.js')
  fs.writeFileSync(script, getHookScriptContent())

  const hits: string[] = []
  const window = (name: string) => new Promise<http.Server>(resolve => {
    const s = http.createServer((req, res) => { hits.push(`${name}:${req.headers['x-switchboard-mirror'] ?? ''}`); req.resume(); req.on('end', () => res.end()) })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
  const owner = await window('owner')
  const other = await window('other')
  const port = (s: http.Server) => (s.address() as { port: number }).port
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ pid: process.pid, port: port(owner), workspace: home }))
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ pid: process.ppid, port: port(other), workspace: '/nowhere/b' }))

  try {
    const child = spawn(process.execPath, [script], { env: { ...process.env, HOME: home, USERPROFILE: home } })
    child.stdin.end(JSON.stringify({ cwd: home, session_id: 's', hook_event_name: 'Stop' }))
    await new Promise(resolve => child.on('exit', resolve))
    assert.deepEqual(hits.sort(), ['other:1', 'owner:'])
  } finally {
    owner.close()
    other.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('a frozen mirror window holds the hook up for a short timeout only', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-frozen-'))
  const dir = path.join(home, '.claude', 'switchboard')
  fs.mkdirSync(dir, { recursive: true })
  const script = path.join(home, 'hook.js')
  fs.writeFileSync(script, getHookScriptContent())

  const hits: string[] = []
  const owner = await listen(hits, 'owner')
  // Takes the post and never answers.
  const frozen = await new Promise<http.Server>(resolve => { const s = http.createServer(() => {}); s.listen(0, '127.0.0.1', () => resolve(s)) })
  const port = (s: http.Server) => (s.address() as { port: number }).port
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ pid: process.pid, port: port(owner), workspace: home }))
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ pid: process.ppid, port: port(frozen), workspace: '/nowhere/b' }))

  try {
    const child = spawn(process.execPath, [script], { env: { ...process.env, HOME: home, USERPROFILE: home } })
    const t0 = Date.now()
    child.stdin.end(JSON.stringify({ cwd: home, session_id: 's', hook_event_name: 'Stop' }))
    await new Promise(resolve => child.on('exit', resolve))
    assert.deepEqual(hits, ['owner'])
    assert.ok(Date.now() - t0 < 800, `took ${Date.now() - t0}ms`)
  } finally {
    owner.close()
    frozen.closeAllConnections()
    frozen.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
