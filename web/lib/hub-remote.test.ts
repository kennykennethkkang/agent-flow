/** The standalone web app's calls to its own proxy. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { downReason, fetchHub, fetchHubWhy, postCommand } from './hub-remote'
import type { HubCommand } from './vscode-bridge'

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

  it('says why the hub is out of reach', async () => {
    assert.match(downReason(401), /signed out/)
    assert.match(downReason(403), /signed out/)
    assert.match(downReason(502), /No VS Code window/)
    assert.match(downReason(undefined), /Cannot reach the Mac/)
    const gone = (async () => new Response('', { status: 403 })) as typeof fetch
    const r = await fetchHubWhy(gone)
    assert.equal(r.hub, null)
    assert.match(r.why ?? '', /signed out/)
    const ok = (async () => new Response('{"chats":[]}', { status: 200 })) as typeof fetch
    assert.deepEqual(await fetchHubWhy(ok), { hub: { chats: [] } })
  })

  it('sends back the last ETag and keeps the state it had on a 304', async () => {
    const sent: Array<string | undefined> = []
    let reply = () => new Response('{"chats":[],"n":1}', { status: 200, headers: { ETag: '"a"' } })
    const f = (async (_u: string, init?: RequestInit) => { sent.push((init?.headers as Record<string, string>)['If-None-Match']); return reply() }) as typeof fetch
    assert.deepEqual(await fetchHubWhy(f), { hub: { chats: [], n: 1 } })
    reply = () => new Response(null, { status: 304, headers: { ETag: '"a"' } })
    assert.deepEqual(await fetchHubWhy(f), { hub: { chats: [], n: 1 } })
    assert.deepEqual(sent.slice(-2), [sent[sent.length - 2], '"a"'])
  })

  it('keeps the to-do lists, ticked and sync, from the proxy state', async () => {
    const todos = { '/p': { todo: [{ id: 'a', text: 'later', at: 1 }], ticked: [{ id: 'b', text: 'did', at: 2, by: 's1' }], sync: { state: 'synced' } } }
    const f = (async () => new Response(JSON.stringify({ chats: [], todos }), { status: 200 })) as typeof fetch
    assert.deepEqual((await fetchHubWhy(f)).hub?.todos, todos)
  })

  it('posts every to-do command to the proxy as it is, Run included, never as a new or remote chat', async () => {
    const cmds: HubCommand[] = [
      { type: 'hub-todo-add', path: '/p', text: 'x' },
      { type: 'hub-todo-edit', path: '/p', id: 'a', text: 'y' },
      { type: 'hub-todo-remove', path: '/p', id: 'a' },
      { type: 'hub-todo-restore', path: '/p', id: 'b' },
      { type: 'hub-todo-run', path: '/p', ids: ['a'] },
      { type: 'hub-todo-run', path: '/p', ids: ['a'], to: 's1' },
      { type: 'hub-todo-sync', path: '/p', on: true },
    ]
    for (const c of cmds) {
      const calls: Array<[string, RequestInit | undefined]> = []
      const f = (async (url: string, init?: RequestInit) => { calls.push([url, init]); return new Response(null, { status: 204 }) }) as typeof fetch
      assert.equal(await postCommand(c, f), undefined, c.type)
      assert.equal(calls.length, 1)
      assert.equal(calls[0][0], '/hub/command')
      assert.equal(calls[0][1]?.method, 'POST')
      assert.equal((calls[0][1]?.headers as Record<string, string>)['X-Switchboard'], '1')
      assert.deepEqual(JSON.parse(String(calls[0][1]?.body)), c)
    }
  })
})
