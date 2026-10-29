/** The standalone web app's calls to its own proxy. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fetchHub, postCommand } from './hub-remote'

describe('hub-remote', () => {
  it('sends the Switchboard header and answers null when the proxy fails', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const ok = (async (url: string, init?: RequestInit) => { calls.push([url, init]); return new Response('{"chats":[]}', { status: 200 }) }) as typeof fetch
    assert.deepEqual(await fetchHub(ok), { chats: [] })
    assert.equal((calls[0][1]?.headers as Record<string, string>)['X-Switchboard'], '1')
    const down = (async () => new Response('', { status: 502 })) as typeof fetch
    assert.equal(await fetchHub(down), null)
    const thrown = (async () => { throw new Error('no server') }) as typeof fetch
    assert.equal(await fetchHub(thrown), null)
  })

  it('posts a command as JSON and answers no problem when it ran', async () => {
    let sent = ''
    const f = (async (_u: string, init?: RequestInit) => { sent = String(init?.body); return new Response(null, { status: 204 }) }) as typeof fetch
    assert.equal(await postCommand({ type: 'hub-refresh' }, f), undefined)
    assert.equal(sent, '{"type":"hub-refresh"}')
  })

  it('answers the reason a command failed', async () => {
    const bad = (async () => new Response('hub-send needs sessionId', { status: 400 })) as typeof fetch
    assert.equal(await postCommand({ type: 'hub-refresh' }, bad), 'hub-send needs sessionId')
    const bare = (async () => new Response('', { status: 502 })) as typeof fetch
    assert.match((await postCommand({ type: 'hub-refresh' }, bare)) ?? '', /502/)
    const thrown = (async () => { throw new Error('no server') }) as typeof fetch
    assert.match((await postCommand({ type: 'hub-refresh' }, thrown)) ?? '', /reach/)
  })
})
