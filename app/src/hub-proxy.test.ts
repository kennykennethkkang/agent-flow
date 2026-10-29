/**
 * The standalone app's hub proxy: which window it talks to, and which browser
 * requests it lets through.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { allowed, lanCookie, lanGate, lanHosts, phoneSecret, pickWindow } from './hub-proxy'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const w = (workspace: string, mtimeMs: number, port = 1) => ({ port, hubToken: 't', workspace, mtimeMs })

describe('pickWindow', () => {
  it('takes the window open on the workspace, else the newest', () => {
    const files = [w('/u/a', 5, 1), w('/u/Armasu', 1, 2), w('/u/b', 9, 3)]
    assert.equal(pickWindow(files, '/u/Armasu')?.port, 2)
    assert.equal(pickWindow(files, '/elsewhere')?.port, 3)
    assert.equal(pickWindow([], '/u')?.port, undefined)
  })
  it('skips a window whose process is gone', () => {
    const files = [{ ...w('/u/Armasu', 9, 1), pid: 11 }, { ...w('/u/Armasu', 1, 2), pid: 22 }]
    assert.equal(pickWindow(files, '/u/Armasu', pid => pid === 22)?.port, 2)
    assert.equal(pickWindow(files, '/u/Armasu', () => false)?.port, undefined)
  })
  it('takes the window whose workspace holds the app folder', () => {
    const files = [w('/u/b', 9, 1), w('/u/Armasu', 1, 2), w('/u/Arm', 5, 3)]
    assert.equal(pickWindow(files, '/u/Armasu/web')?.port, 2)
  })
  it('skips files without a port or token', () => {
    assert.equal(pickWindow([{ workspace: '/u', mtimeMs: 9 } as never, w('/u', 1, 4)], '/x')?.port, 4)
  })
})

describe('allowed', () => {
  const ok = { host: '127.0.0.1:3010', 'x-switchboard': '1' }
  it('lets the app own page through', () => {
    assert.equal(allowed(ok, 3010), true)
    assert.equal(allowed({ ...ok, host: 'localhost:3010', origin: 'http://localhost:3010' }, 3010), true)
  })
  it('refuses another site, a rebound name and a request without the header', () => {
    assert.equal(allowed({ ...ok, origin: 'http://evil.test' }, 3010), false)
    assert.equal(allowed({ ...ok, host: 'evil.test:3010' }, 3010), false)
    assert.equal(allowed({ host: '127.0.0.1:3010' }, 3010), false)
  })
})

describe('lanGate', () => {
  const lan = { host: '192.168.1.5', secret: 'a'.repeat(64) }
  const h = { host: '192.168.1.5:3131' }
  it('passes loopback requests as before', () => {
    assert.equal(lanGate({ host: '127.0.0.1:3131' }, '/', 3131, undefined), 'ok')
    assert.equal(allowed({ host: '127.0.0.1:3131', 'x-switchboard': '1' }, 3131), true)
    assert.equal(allowed({ host: '192.168.1.5:3131', 'x-switchboard': '1' }, 3131), false)
  })
  it('refuses a LAN request without the secret or with a wrong one', () => {
    assert.equal(lanGate(h, '/', 3131, lan), 'deny')
    assert.equal(lanGate(h, '/hub/state', 3131, lan), 'deny')
    assert.equal(lanGate(h, '/?k=' + 'b'.repeat(64), 3131, lan), 'deny')
    assert.equal(lanGate(h, '/?k=short', 3131, lan), 'deny')
    assert.equal(lanGate({ ...h, cookie: 'sb3131=' + 'b'.repeat(64) }, '/', 3131, lan), 'deny')
  })
  it('logs in with the QR secret once, then lets the cookie through', () => {
    assert.equal(lanGate(h, '/?k=' + lan.secret, 3131, lan), 'login')
    assert.equal(lanGate({ ...h, cookie: 'x=1; sb3131=' + lan.secret }, '/hub/state', 3131, lan), 'ok')
    assert.equal(allowed({ ...h, 'x-switchboard': '1', origin: 'http://192.168.1.5:3131' }, 3131, lan.host), true)
    assert.equal(allowed({ ...h }, 3131, lan.host), false)
  })
  it('refuses a path it cannot parse instead of throwing', () => {
    assert.equal(lanGate(h, '//', 3131, lan), 'deny')
    assert.equal(lanGate({ ...h, cookie: 'sb3131=' + lan.secret }, '//', 3131, lan), 'deny')
  })
  it('names the cookie per port, so two apps on one IP keep apart', () => {
    assert.equal(lanCookie(3131), 'sb3131')
    assert.equal(lanGate({ ...h, cookie: 'sb=' + lan.secret }, '/', 3131, lan), 'deny')
    assert.equal(lanGate({ ...h, cookie: 'sb3001=' + lan.secret }, '/', 3131, lan), 'deny')
  })
  it('refuses another Host even with the right secret', () => {
    assert.equal(lanGate({ host: 'evil.test:3131', cookie: 'sb3131=' + lan.secret }, '/', 3131, lan), 'deny')
    assert.equal(lanGate({ host: 'evil.test:3131' }, '/?k=' + lan.secret, 3131, lan), 'deny')
  })
})

describe('lanHosts', () => {
  it('splits Wi-Fi from Tailscale (100.64.0.0/10)', () => {
    assert.deepEqual(lanHosts(['100.101.2.3', '192.168.1.5']), { wifi: '192.168.1.5', tailscale: '100.101.2.3' })
    assert.deepEqual(lanHosts(['192.168.1.5']), { wifi: '192.168.1.5', tailscale: undefined })
    assert.deepEqual(lanHosts(['100.64.0.1', '100.127.255.1']), { wifi: undefined, tailscale: '100.64.0.1' })
    // Outside the CGNAT block: plain addresses
    assert.deepEqual(lanHosts(['100.63.0.1', '100.128.0.1']), { wifi: '100.63.0.1', tailscale: undefined })
  })
  it('gates each socket on its own Host only', () => {
    const secret = 'a'.repeat(64), cookie = 'sb3131=' + secret
    const wifi = { host: '192.168.1.5', secret }, ts = { host: '100.101.2.3', secret }
    assert.equal(lanGate({ host: '100.101.2.3:3131', cookie }, '/', 3131, ts), 'ok')
    assert.equal(lanGate({ host: '192.168.1.5:3131', cookie }, '/', 3131, wifi), 'ok')
    assert.equal(lanGate({ host: '192.168.1.5:3131', cookie }, '/', 3131, ts), 'deny')
    assert.equal(lanGate({ host: '192.168.1.5:3131' }, '/?k=' + secret, 3131, ts), 'deny')
    assert.equal(lanGate({ host: '100.101.2.3:3131', cookie }, '/', 3131, wifi), 'deny')
    assert.equal(allowed({ host: '100.101.2.3:3131', 'x-switchboard': '1', origin: 'http://100.101.2.3:3131' }, 3131, ts.host), true)
    assert.equal(allowed({ host: '192.168.1.5:3131', 'x-switchboard': '1' }, 3131, ts.host), false)
  })
})

describe('phoneSecret', () => {
  it('keeps one secret across restarts, readable only by the owner, and replaces a bad file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-secret-')), 'sub', 'phone.secret')
    const first = phoneSecret(file)
    assert.match(first, /^[0-9a-f]{64}$/)
    assert.equal(phoneSecret(file), first)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    fs.writeFileSync(file, 'short')
    assert.notEqual(phoneSecret(file), 'short')
  })
})
