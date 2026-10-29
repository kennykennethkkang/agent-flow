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

const listen = (hits: string[], name: string) => new Promise<http.Server>(resolve => {
  const s = http.createServer((req, res) => { hits.push(name); req.resume(); req.on('end', () => res.end()) })
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
