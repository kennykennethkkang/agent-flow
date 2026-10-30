/** AWS sign-ins: reading ~/.aws/config, rewriting [default], labels, Chrome profiles and status. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'path'
import { accountOf, addProfile, awsStatus, chromeCall, chromeProfiles, chromeState, openChromeScript, makeDefault, parseAwsConfig, profileFor, validProfileName, validRegion } from '../src/hub/aws'

const ARN = (acct: string) => `arn:aws:iam::${acct}:root`
const CONFIG = [
  '[default]', 'region = us-west-1', 'output = json', `login_session = ${ARN('137809407381')}`, '',
  '[profile live]', 'region = us-west-1', `login_session = ${ARN('137809407381')}`,
  '[profile yo]', 'region = us-east-1', `login_session = ${ARN('457884741882')}`, '',
  '[sso-session corp]', 'sso_start_url = https://x.awsapps.com/start', '',
  '[profile sso]', 'sso_account_id = 111122223333', 'sso_session = corp', 'region = eu-central-1', '',
].join('\n')

describe('aws config', () => {
  it('reads profiles with their settings, default first, skipping sso-session blocks', () => {
    const s = parseAwsConfig(CONFIG)
    assert.deepEqual(s.map(x => [x.name, x.isDefault]), [['default', true], ['live', false], ['yo', false], ['sso', false]])
    assert.equal(s[2].values.region, 'us-east-1')
  })

  it('finds the account from a login session, an SSO account or a role arn', () => {
    assert.equal(accountOf({ login_session: ARN('137809407381') }), '137809407381')
    assert.equal(accountOf({ sso_account_id: '111122223333' }), '111122223333')
    assert.equal(accountOf({ role_arn: 'arn:aws:iam::444455556666:role/admin' }), '444455556666')
    assert.equal(accountOf({ region: 'us-west-1' }), undefined)
  })

  it('makes a profile the default and backs up the old default when its account differs', () => {
    const out = makeDefault(CONFIG, 'yo', Date.UTC(2026, 9, 28, 15, 4, 5))!
    const s = parseAwsConfig(out)
    const def = s.find(x => x.isDefault)!
    assert.equal(def.values.region, 'us-east-1')
    assert.equal(accountOf(def.values), '457884741882')
    const backup = s.find(x => x.name.startsWith('previous-default-'))!
    assert.match(backup.name, /^previous-default-20261028-150405$/)
    assert.equal(accountOf(backup.values), '137809407381')
    assert.equal(backup.values.output, 'json')
    // Everything else is left as it was.
    assert.ok(out.includes('[sso-session corp]') && out.includes('[profile live]') && out.includes('[profile yo]'))
  })

  it('skips the backup only when the old default is the same as the new one, and refuses an unknown profile', () => {
    const same = '[default]\nregion = us-west-1\n\n[profile twin]\nregion = us-west-1\n'
    assert.ok(!makeDefault(same, 'twin', 1)!.includes('previous-default'))
    // Same account, another role: the old role must survive.
    const roles = '[default]\nrole_arn = arn:aws:iam::111122223333:role/Admin\n\n[profile ro]\nrole_arn = arn:aws:iam::111122223333:role/ReadOnly\n'
    assert.match(makeDefault(roles, 'ro', 1)!, /\[profile previous-default-[^\]]+\]\nrole_arn = arn:aws:iam::111122223333:role\/Admin/)
    // No account on either side: still kept.
    const proc = '[default]\ncredential_process = /usr/local/bin/creds\n\n[profile bare]\nregion = us-east-2\n'
    assert.match(makeDefault(proc, 'bare', 1)!, /\[profile previous-default-[^\]]+\]\ncredential_process = \/usr\/local\/bin\/creds/)
    const out = makeDefault(CONFIG, 'live', 1)!
    assert.ok(out.includes('previous-default'))
    assert.equal(makeDefault(CONFIG, 'nope', 1), undefined)
    assert.equal(makeDefault(CONFIG, 'default', 1), undefined)
  })

  it('points source_profile = default at the backup when the old [default] held keys in config', () => {
    const text = '[default]\naws_access_key_id = AKIAEXAMPLE\naws_secret_access_key = x\n\n[profile admin]\nrole_arn = arn:aws:iam::444444444444:role/A\nsource_profile = default\n'
    const s = parseAwsConfig(makeDefault(text, 'admin', Date.UTC(2026, 9, 28, 15, 4, 5))!)
    assert.equal(s.find(x => x.isDefault)?.values.source_profile, 'previous-default-20261028-150405')
  })

  it('moves every profile sourcing from a keyed [default] to the backup, not just the new default', () => {
    const text = '[default]\naws_access_key_id = AKIAEXAMPLE\n\n[profile admin]\nrole_arn = arn:aws:iam::444444444444:role/A\nsource_profile = default\n\n[profile ops]\nrole_arn = arn:aws:iam::555555555555:role/B\nsource_profile = default\n'
    const s = parseAwsConfig(makeDefault(text, 'admin', Date.UTC(2026, 9, 28, 15, 4, 5))!)
    for (const n of ['admin', 'ops']) assert.equal(s.find(x => x.name === n)?.values.source_profile, 'previous-default-20261028-150405')
  })

  it('keeps source_profile = default, since its keys live in credentials [default]', () => {
    const text = '[default]\naws_account_id = 333333333333\n\n[profile admin]\nrole_arn = arn:aws:iam::444444444444:role/A\nsource_profile = default\n'
    const s = parseAwsConfig(makeDefault(text, 'admin', Date.UTC(2026, 9, 28, 15, 4, 5))!)
    assert.equal(s.find(x => x.isDefault)?.values.source_profile, 'default')
    assert.equal(s.find(x => x.name === 'admin')?.values.source_profile, 'default')
  })

  it('leaves a comment that heads the next section with that section', () => {
    const text = '[default]\nregion = us-west-1\n\n[profile a]\nregion = us-east-2\n# the sandbox account\n[profile b]\nregion = eu-west-1\n'
    const out = makeDefault(text, 'a', 1)!
    const def = out.slice(out.indexOf('[default]'), out.indexOf('[profile a]'))
    assert.ok(!def.includes('sandbox'), def)
    assert.ok(out.includes('# the sandbox account\n[profile b]'))
  })

  it('adds [default] when there is none', () => {
    const out = makeDefault('[profile a]\nregion = us-east-2\n', 'a', 1)!
    assert.equal(parseAwsConfig(out).find(x => x.isDefault)?.values.region, 'us-east-2')
  })

  it('adds a profile once, with its region', () => {
    const out = addProfile(CONFIG, 'new.one', 'ap-southeast-2')!
    assert.equal(parseAwsConfig(out).find(x => x.name === 'new.one')?.values.region, 'ap-southeast-2')
    assert.equal(addProfile(CONFIG, 'live', 'us-west-1'), undefined)
    assert.equal(addProfile(CONFIG, 'bad name', 'us-west-1'), undefined)
    assert.equal(addProfile(CONFIG, 'ok', 'us-west-1; rm'), undefined)
  })

  it('takes only safe profile names and real-looking regions', () => {
    for (const ok of ['live', 'a.b_c-d', 'me@corp+dev', 'x'.repeat(64)]) assert.ok(validProfileName(ok), ok)
    for (const bad of ['', 'a b', 'a]b', '$(x)', 'x'.repeat(65), 'a\nb']) assert.ok(!validProfileName(bad), bad)
    for (const ok of ['us-west-1', 'eu-central-1', 'us-gov-west-1', 'ap-southeast-2']) assert.ok(validRegion(ok), ok)
    for (const bad of ['', 'west', 'us-west', 'US-WEST-1', 'us-west-1 ']) assert.ok(!validRegion(bad), bad)
  })
})

describe('aws status and helpers', () => {
  it('says signed in, expired or never', () => {
    assert.equal(awsStatus(true, '', {}), 'signed-in')
    assert.equal(awsStatus(false, 'Unable to locate credentials.', { region: 'us-west-1' }), 'never')
    assert.equal(awsStatus(false, 'Your session has expired. Please reauthenticate using aws login.', { login_session: ARN('137809407381') }), 'expired')
    assert.equal(awsStatus(false, 'Token has expired and refresh failed', { sso_session: 'corp' }), 'expired')
    assert.equal(awsStatus(false, 'timed out', {}), 'never')
  })

  it('reads Chrome profiles from Local State', () => {
    const state = JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal', user_name: 'k@gmail.com' }, 'Profile 2': { name: 'Work' }, bad: 3 } } })
    assert.deepEqual(chromeProfiles(state), [{ dir: 'Default', name: 'Personal', email: 'k@gmail.com' }, { dir: 'Profile 2', name: 'Work' }])
    assert.deepEqual(chromeProfiles('nope'), [])
  })

  it('picks the profile of the deepest project folder holding a path', () => {
    const projects = { '/u/GitHub': 'live', '/u/GitHub/Armasu': 'yo' }
    assert.equal(profileFor(projects, '/u/GitHub/Armasu/web'), 'yo')
    assert.equal(profileFor(projects, '/u/GitHub/agent-flow'), 'live')
    assert.equal(profileFor(projects, '/u/GitHubX'), undefined)
  })

  it('finds Chrome\'s Local State on each OS', () => {
    assert.equal(chromeState('darwin', '/h', {}), path.join('/h', 'Library', 'Application Support', 'Google', 'Chrome', 'Local State'))
    assert.equal(chromeState('linux', '/h', {}), path.join('/h', '.config', 'google-chrome', 'Local State'))
    assert.equal(chromeState('win32', 'C:\\Users\\k', { LOCALAPPDATA: 'C:\\Users\\k\\AppData\\Local' }), path.join('C:\\Users\\k\\AppData\\Local', 'Google', 'Chrome', 'User Data', 'Local State'))
    assert.equal(chromeState('win32', 'C:\\Users\\k', {}), path.join('C:\\Users\\k', 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Local State'))
  })

  it('opens a URL in one Chrome profile without a shell', () => {
    const url = 'https://signin.aws.amazon.com/a?x=1&y=2'
    assert.deepEqual(chromeCall(url, 'Profile 2', 'darwin', {}, () => false), { cmd: '/usr/bin/open', args: ['-na', 'Google Chrome', '--args', '--profile-directory=Profile 2', url] })
    const pf = path.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')
    assert.deepEqual(chromeCall(url, 'Default', 'win32', { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\L' }, f => f === pf), { cmd: pf, args: ['--profile-directory=Default', url] })
    const la = path.join('C:\\L', 'Google', 'Chrome', 'Application', 'chrome.exe')
    assert.equal(chromeCall(url, 'Default', 'win32', { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\L' }, f => f === la)?.cmd, la)
    assert.equal(chromeCall(url, 'Default', 'win32', {}, () => false), undefined)
    assert.equal(chromeCall(url, 'Default', 'linux', {}, () => false)?.cmd, 'google-chrome')
  })

  it('writes a BROWSER script on macOS and Linux only; a .cmd would split a URL at &', () => {
    assert.match(openChromeScript('darwin')!, /\/usr\/bin\/open -na "Google Chrome" --args --profile-directory="\$SWITCHBOARD_CHROME_DIR" "\$1"/)
    assert.match(openChromeScript('linux')!, /google-chrome --profile-directory="\$SWITCHBOARD_CHROME_DIR" "\$1"/)
    assert.equal(openChromeScript('win32'), undefined)
  })
})
