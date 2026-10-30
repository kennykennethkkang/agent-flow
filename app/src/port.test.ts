/**
 * Two app copies must never share a port: macOS lets 127.0.0.1 and 0.0.0.0 both bind it.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { portTaken } from './port'

const listen = (host: string) => new Promise<http.Server>(done => { const s = http.createServer(); s.listen(0, host, () => done(s)) })

describe('portTaken', () => {
  it('sees a copy on loopback or on every address', async () => {
    for (const host of ['127.0.0.1', '0.0.0.0']) {
      const s = await listen(host)
      const port = (s.address() as AddressInfo).port
      try { assert.equal(await portTaken(port), true) } finally { await new Promise(r => s.close(r)) }
      assert.equal(await portTaken(port), false)
    }
  })
})
