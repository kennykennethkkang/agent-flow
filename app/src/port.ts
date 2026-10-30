import * as net from 'net'

/** True when something answers on 127.0.0.1:port. A 0.0.0.0 listener answers there too. */
export const portTaken = (port: number) => new Promise<boolean>(done => {
  const s = net.connect(port, '127.0.0.1')
  s.setTimeout(500)
  s.once('connect', () => { s.destroy(); done(true) })
  s.once('timeout', () => { s.destroy(); done(true) })
  s.once('error', () => done(false))
})
