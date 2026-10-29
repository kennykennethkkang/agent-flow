/**
 * The standalone app's hub proxy: which window it talks to, and which browser
 * requests it lets through.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { allowed, codeLogin, deniedAs, deviceAsks, lanCookie, lanFor, lanGate, lanHosts, liveToken, localName, phoneCode, phoneSecret, pickWindow, signInPage, tailscaleName, uaSummary, waitPage } from './hub-proxy'
import * as crypto from 'crypto'
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
    assert.equal(allowed({ ...h, 'x-switchboard': '1', origin: 'http://192.168.1.5:3131' }, 3131, lan), true)
    assert.equal(allowed({ ...h }, 3131, lan), false)
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

describe('lanFor', () => {
  const secret = 'a'.repeat(64)
  it('lets loopback through ungated and pins the rest to the address they came in on', () => {
    assert.equal(lanFor('127.0.0.1', secret), undefined)
    assert.equal(lanFor('::ffff:127.0.0.1', secret), undefined)
    assert.equal(lanFor('::1', secret), undefined)
    assert.deepEqual(lanFor('::ffff:192.168.1.103', secret), { host: '192.168.1.103', secret, names: [] })
    assert.deepEqual(lanFor('100.101.2.3', secret), { host: '100.101.2.3', secret, names: [] })
  })
  it('follows a new Wi-Fi address without a restart', () => {
    const lan = lanFor('192.168.1.103', secret)
    assert.equal(lanGate({ host: '192.168.1.103:3131', cookie: 'sb3131=' + secret }, '/', 3131, lan), 'ok')
    assert.equal(lanGate({ host: '192.168.1.236:3131', cookie: 'sb3131=' + secret }, '/', 3131, lan), 'deny')
  })
  it('gates a request with no local address', () => {
    assert.equal(lanGate({ host: 'x:3131' }, '/', 3131, lanFor(undefined, secret)), 'deny')
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
    assert.equal(allowed({ host: '100.101.2.3:3131', 'x-switchboard': '1', origin: 'http://100.101.2.3:3131' }, 3131, ts), true)
    assert.equal(allowed({ host: '192.168.1.5:3131', 'x-switchboard': '1' }, 3131, ts), false)
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

describe('phoneCode', () => {
  it('is six digits, the same every time for one secret', () => {
    const a = phoneCode('a'.repeat(64))
    assert.match(a, /^\d{6}$/)
    assert.equal(phoneCode('a'.repeat(64)), a)
    assert.notEqual(phoneCode('b'.repeat(64)), a)
    // HMAC-SHA256(secret, 'switchboard-code'), first 4 bytes mod 1e6
    assert.equal(phoneCode('k'), String(crypto.createHmac('sha256', 'k').update('switchboard-code').digest().readUInt32BE(0) % 1e6).padStart(6, '0'))
  })
})

describe('deniedAs', () => {
  const lan = { host: '192.168.1.5', secret: 'a'.repeat(64) }
  const h = { host: '192.168.1.5:3131' }
  it('gives a typed page address the sign-in page', () => {
    assert.equal(deniedAs('GET', h, '/', 3131, lan), 'page')
    assert.equal(deniedAs('GET', { ...h, accept: 'text/html,*/*' }, '/chat/1', 3131, lan), 'page')
    assert.equal(deniedAs('GET', h, '/?k=wrong', 3131, lan), 'page')
  })
  it('takes the code on POST /login only', () => {
    assert.equal(deniedAs('POST', h, '/login', 3131, lan), 'login')
    assert.equal(deniedAs('POST', h, '/', 3131, lan), 'forbid')
  })
  it('keeps refusing everything that is not a page', () => {
    assert.equal(deniedAs('GET', h, '/events', 3131, lan), 'forbid')
    assert.equal(deniedAs('GET', h, '/hub/state', 3131, lan), 'forbid')
    assert.equal(deniedAs('GET', { ...h, accept: '*/*' }, '/_next/app.js', 3131, lan), 'forbid')
    assert.equal(deniedAs('GET', h, '//', 3131, lan), 'forbid')
  })
  it('pins the Host, so a rebound name gets neither page nor login', () => {
    assert.equal(deniedAs('GET', { host: 'evil.test:3131' }, '/', 3131, lan), 'forbid')
    assert.equal(deniedAs('POST', { host: 'evil.test:3131' }, '/login', 3131, lan), 'forbid')
    assert.equal(deniedAs('GET', { host: '192.168.1.5:3001' }, '/', 3131, lan), 'forbid')
  })
})

describe('codeLogin', () => {
  const secret = 'a'.repeat(64), code = phoneCode(secret)
  const wrong = code === '000000' ? '000001' : '000000'
  it('takes the right code and refuses a wrong one', () => {
    const check = codeLogin()
    assert.equal(check(code, secret), 'ok')
    assert.equal(check(wrong, secret), 'wrong')
    assert.equal(check('', secret), 'wrong')
    assert.equal(check(code + '0', secret), 'wrong')
  })
  it('locks after 5 wrong codes in 10 minutes, even for the right one, then lets go', () => {
    let t = 0
    const check = codeLogin(() => t)
    for (let i = 0; i < 5; i++) assert.equal(check(wrong, secret), 'wrong')
    assert.equal(check(wrong, secret), 'locked')
    assert.equal(check(code, secret), 'locked')
    t = 10 * 60_000
    assert.equal(check(code, secret), 'ok')
  })
})

describe('signInPage', () => {
  it('is one numeric field posting to /login, with no outside loads', () => {
    const page = signInPage()
    assert.match(page, /action="\/login" method="post"/)
    assert.match(page, /inputmode="numeric"/)
    assert.match(page, /autocomplete="one-time-code"/)
    assert.match(page, /prefers-color-scheme: dark/)
    assert.doesNotMatch(page, /https?:\/\/|<script|\u2014/)
    assert.match(signInPage('Wrong code'), /Wrong code/)
  })
})

describe('sign-in hardening', () => {
  const lan = { host: '192.168.1.103', secret: 'a'.repeat(64) }
  const h = { host: '192.168.1.103:3131' }
  it('takes /login only from the page itself or with no Origin', () => {
    assert.equal(deniedAs('POST', h, '/login', 3131, lan), 'login')
    assert.equal(deniedAs('POST', { ...h, origin: 'http://192.168.1.103:3131' }, '/login', 3131, lan), 'login')
    assert.equal(deniedAs('POST', { ...h, origin: 'http://evil.example' }, '/login', 3131, lan), 'forbid')
    assert.equal(deniedAs('POST', { ...h, origin: 'null' }, '/login', 3131, lan), 'forbid')
  })
  it('a right code clears the wrong ones', () => {
    const check = codeLogin(() => 0)
    for (let i = 0; i < 4; i++) assert.equal(check('000000', lan.secret), 'wrong')
    assert.equal(check(phoneCode(lan.secret), lan.secret), 'ok')
    for (let i = 0; i < 4; i++) assert.equal(check('000000', lan.secret), 'wrong')
    assert.equal(check(phoneCode(lan.secret), lan.secret), 'ok')
  })
})

describe('Mac names', () => {
  const secret = 'a'.repeat(64), cookie = 'sb3131=' + secret
  const lan = lanFor('192.168.1.103', secret, ['kennys-mbp.local', 'kennys-mbp.tail1234.ts.net'])!
  it('takes the mDNS and MagicDNS names like the address, any case', () => {
    assert.equal(lanGate({ host: 'kennys-mbp.local:3131', cookie }, '/', 3131, lan), 'ok')
    assert.equal(lanGate({ host: 'Kennys-MBP.local:3131', cookie }, '/', 3131, lan), 'ok')
    assert.equal(lanGate({ host: 'kennys-mbp.tail1234.ts.net:3131' }, '/?k=' + secret, 3131, lan), 'login')
    assert.equal(lanGate({ host: '192.168.1.103:3131', cookie }, '/', 3131, lan), 'ok')
    assert.equal(deniedAs('GET', { host: 'kennys-mbp.local:3131' }, '/', 3131, lan), 'page')
    assert.equal(deniedAs('POST', { host: 'kennys-mbp.local:3131', origin: 'http://kennys-mbp.local:3131' }, '/login', 3131, lan), 'login')
    assert.equal(allowed({ host: 'kennys-mbp.local:3131', 'x-switchboard': '1', origin: 'http://kennys-mbp.local:3131' }, 3131, lan), true)
  })
  it('refuses any other name, a lookalike or the wrong port (DNS rebinding)', () => {
    for (const host of ['evil.test:3131', 'kennys-mbp.local.evil.test:3131', 'x.kennys-mbp.local:3131', 'kennys-mbp.local:3001', 'kennys-mbp.local', 'tail1234.ts.net:3131']) {
      assert.equal(lanGate({ host, cookie }, '/', 3131, lan), 'deny', host)
      assert.equal(deniedAs('GET', { host }, '/', 3131, lan), 'forbid', host)
      assert.equal(allowed({ host, 'x-switchboard': '1' }, 3131, lan), false, host)
    }
    assert.equal(allowed({ host: 'kennys-mbp.local:3131', 'x-switchboard': '1', origin: 'http://evil.test' }, 3131, lan), false)
    assert.equal(deniedAs('POST', { host: 'kennys-mbp.local:3131', origin: 'http://evil.test' }, '/login', 3131, lan), 'forbid')
    // Without names only the address passes.
    assert.equal(lanGate({ host: 'kennys-mbp.local:3131', cookie }, '/', 3131, lanFor('192.168.1.103', secret)), 'deny')
  })
  it('reads the names from scutil and tailscale, lowercased, without the trailing dot', () => {
    assert.equal(localName('Kennys-MacBook-Pro\n'), 'kennys-macbook-pro.local')
    assert.equal(localName(''), undefined)
    assert.equal(localName('bad name!'), undefined)
    const ts = (o: object) => JSON.stringify(o)
    assert.equal(tailscaleName(ts({ BackendState: 'Running', Self: { DNSName: 'Kennys-MBP.tail1234.ts.net.' } })), 'kennys-mbp.tail1234.ts.net')
    assert.equal(tailscaleName(ts({ BackendState: 'Stopped', Self: { DNSName: 'a.ts.net.' } })), undefined)
    assert.equal(tailscaleName(ts({ BackendState: 'Running', Self: { DNSName: 'a b.ts.net.' } })), undefined)
    assert.equal(tailscaleName('not json'), undefined)
  })
})

describe('device approval', () => {
  const lan = { host: '192.168.1.103', secret: 'a'.repeat(64) }
  const h = { host: '192.168.1.103:3131' }
  const d = { ip: '192.168.1.50', ua: 'iPhone Safari', host: '192.168.1.103:3131', network: 'Wi-Fi' as const }
  it('routes Ask and the wait page past the gate, with the /login Origin rule', () => {
    assert.equal(deniedAs('POST', h, '/device', 3131, lan), 'device')
    assert.equal(deniedAs('POST', { ...h, origin: 'http://192.168.1.103:3131' }, '/device', 3131, lan), 'device')
    assert.equal(deniedAs('POST', { ...h, origin: 'http://evil.test' }, '/device', 3131, lan), 'forbid')
    assert.equal(deniedAs('GET', h, '/device/wait?id=x', 3131, lan), 'wait')
    assert.equal(deniedAs('GET', { host: 'evil.test:3131' }, '/device/wait?id=x', 3131, lan), 'forbid')
    assert.equal(deniedAs('POST', h, '/device/answer', 3131, lan), 'forbid')
  })
  it('creates a pending ask with a 128-bit id, at most 3 at once', () => {
    const asks = deviceAsks(() => 0)
    const a = asks.ask(d)!
    assert.match(a.id, /^[0-9a-f]{32}$/)
    assert.equal(asks.state(a.id), 'pending')
    asks.ask(d); asks.ask(d)
    assert.equal(asks.ask(d), undefined)
    assert.equal(asks.state('nope'), 'gone')
  })
  it('expires an unanswered ask after 2 minutes, which frees its place', () => {
    let t = 0
    const asks = deviceAsks(() => t)
    const a = asks.ask(d)!
    asks.ask(d); asks.ask(d)
    t = 2 * 60_000
    assert.equal(asks.state(a.id), 'gone')
    assert.equal(asks.answer(a.id, true), false)
    assert.ok(asks.ask(d))
  })
  it('allow and deny are answered once and read once', () => {
    const asks = deviceAsks(() => 0)
    const a = asks.ask(d)!, b = asks.ask(d)!
    assert.equal(asks.answer(a.id, true), true)
    assert.equal(asks.answer(a.id, true), false)
    assert.equal(asks.answer(b.id, false), true)
    assert.equal(asks.state(a.id), 'allowed')
    assert.equal(asks.state(a.id), 'gone')
    assert.equal(asks.state(b.id), 'denied')
    assert.equal(asks.state(b.id), 'gone')
  })
  it('an answered ask no longer counts toward the cap', () => {
    const asks = deviceAsks(() => 0)
    const a = asks.ask(d)!
    asks.ask(d); asks.ask(d)
    asks.answer(a.id, true)
    assert.ok(asks.ask(d))
  })
  it('sums up a User-Agent in a few words', () => {
    assert.equal(uaSummary('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'), 'iPhone Safari')
    assert.equal(uaSummary('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1'), 'iPhone Chrome')
    assert.equal(uaSummary('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36'), 'Android Chrome')
    assert.equal(uaSummary('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0'), 'Windows Edge')
    assert.equal(uaSummary('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0'), 'Mac Firefox')
    assert.equal(uaSummary('curl/8.7.1'), 'Unknown browser')
    assert.equal(uaSummary(undefined), 'Unknown browser')
  })
  it('takes an answer only with the token of a live window', () => {
    const files = [{ port: 1, hubToken: 'live', workspace: '/u', mtimeMs: 1, pid: 11 }, { port: 2, hubToken: 'dead', workspace: '/u', mtimeMs: 1, pid: 22 }, { workspace: '/u', mtimeMs: 1 }]
    const alive = (pid: number) => pid === 11
    assert.equal(liveToken(files, 'live', alive), true)
    assert.equal(liveToken(files, 'dead', alive), false)
    assert.equal(liveToken(files, 'nope', alive), false)
    assert.equal(liveToken(files, '', alive), false)
    assert.equal(liveToken(files, undefined, alive), false)
  })
  it('the sign-in page asks the Mac first, the code stays below, no scripts', () => {
    const page = signInPage()
    assert.match(page, /action="\/device" method="post"/)
    assert.match(page, /Ask the Mac to let me in/)
    assert.ok(page.indexOf('action="/device"') < page.indexOf('action="/login"'))
    assert.doesNotMatch(page, /<script|\u2014/)
  })
  it('the wait page refreshes itself to its own id, no scripts', () => {
    const id = 'ab'.repeat(16)
    const page = waitPage(id)
    assert.match(page, new RegExp(`<meta http-equiv="refresh" content="2;url=/device/wait\\?id=${id}">`))
    assert.doesNotMatch(page, /<script|https?:\/\/|\u2014/)
    assert.doesNotMatch(waitPage('"><x'), /"><x/)
  })
})
