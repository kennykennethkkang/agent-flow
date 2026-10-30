import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { forgetAccessNote, noteBody, syncAccessNote, type Run } from '../src/hub/access-note'

const urls = { wifi: 'http://192.168.1.5:3131/?k=s3cret', tailscaleName: 'http://mac.tail.ts.net:3131/?k=s3cret', code: '123456' }
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'note-')), 'access-note.sha')
const recorder = (fail = false) => {
  const calls: { args: string[]; env: Record<string, string> }[] = []
  const run: Run = async (args, env) => { calls.push({ args, env }); if (fail) throw new Error('not allowed') }
  return { calls, run }
}

describe('access note', () => {
  it('noteBody has the title, code and labelled links with Tailscale name first', () => {
    const b = noteBody(urls)
    assert.ok(b.startsWith('<div><h1>Switchboard access</h1></div>'))
    assert.ok(b.includes('123456'))
    assert.ok(b.indexOf('mac.tail.ts.net') < b.indexOf('192.168.1.5'))
    assert.ok(b.includes('<a href="http://mac.tail.ts.net:3131/?k=s3cret">'))
    assert.match(b, /Tailscale must be on/)
  })

  it('writes once, then skips while the body is the same, and keeps no secret on disk', async () => {
    const file = tmp(), { calls, run } = recorder()
    assert.equal(await syncAccessNote(urls, 'darwin', run, file), true)
    assert.equal(await syncAccessNote(urls, 'darwin', run, file), false)
    assert.equal(calls.length, 1)
    assert.ok(!fs.readFileSync(file, 'utf8').includes('s3cret'))
    assert.equal(await syncAccessNote({ ...urls, code: '654321' }, 'darwin', run, file), true)
    assert.equal(calls.length, 2)
  })

  it('passes the body in the environment, never in argv', async () => {
    const { calls, run } = recorder()
    await syncAccessNote(urls, 'darwin', run, tmp())
    assert.ok(!calls[0].args.join(' ').includes('s3cret'))
    assert.ok(!calls[0].args.join(' ').includes('123456'))
    assert.equal(calls[0].env.SB_NOTE, noteBody(urls))
  })

  it('only runs on a Mac, with a code and a link', async () => {
    const { calls, run } = recorder()
    await syncAccessNote(urls, 'linux', run, tmp())
    await syncAccessNote({ code: '123456' }, 'darwin', run, tmp())
    await syncAccessNote({ wifi: urls.wifi }, 'darwin', run, tmp())
    await syncAccessNote(null, 'darwin', run, tmp())
    assert.equal(calls.length, 0)
  })

  it('after a failure stores no hash and waits ten minutes', async () => {
    const file = tmp(), bad = recorder(true)
    let t = 1_000_000
    assert.equal(await syncAccessNote(urls, 'darwin', bad.run, file, () => t), false)
    assert.ok(!fs.existsSync(file))
    t += 9 * 60_000
    assert.equal(await syncAccessNote(urls, 'darwin', bad.run, file, () => t), false)
    assert.equal(bad.calls.length, 1)
    t += 2 * 60_000
    const good = recorder()
    assert.equal(await syncAccessNote(urls, 'darwin', good.run, file, () => t), true)
    assert.equal(good.calls.length, 1)
  })

  it('keeps one call in flight', async () => {
    const calls: string[][] = []
    let release!: () => void
    const run: Run = args => { calls.push(args); return new Promise(r => { release = r }) }
    const file = tmp()
    const first = syncAccessNote(urls, 'darwin', run, file)
    assert.equal(await syncAccessNote(urls, 'darwin', run, file), false)
    while (!calls.length) await new Promise(r => setTimeout(r, 1))
    release()
    assert.equal(await first, true)
    assert.equal(calls.length, 1)
  })

  it('skips while another window holds the lock, and takes over a stale one', async () => {
    const file = tmp(), { calls, run } = recorder()
    fs.writeFileSync(file + '.lock', '')
    assert.equal(await syncAccessNote(urls, 'darwin', run, file), false)
    const old = new Date(Date.now() - 120_000)
    fs.utimesSync(file + '.lock', old, old)
    assert.equal(await syncAccessNote(urls, 'darwin', run, file), true)
    assert.equal(calls.length, 1)
    assert.ok(!fs.existsSync(file + '.lock'))
  })

  it('forgetAccessNote makes the next sync write again, for a deleted note', async () => {
    const file = tmp(), { calls, run } = recorder()
    await syncAccessNote(urls, 'darwin', run, file)
    forgetAccessNote(file)
    assert.equal(await syncAccessNote(urls, 'darwin', run, file), true)
    assert.equal(calls.length, 2)
  })
})
