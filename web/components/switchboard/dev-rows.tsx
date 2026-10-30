'use client'
import { useState } from 'react'
import type { DevProject } from '@/lib/hub-types'
import type { HubCommand } from '@/lib/vscode-bridge'
import { caps } from './look'
import { PhoneQr } from './phone-qr'

const small = { padding: '6px 10px', fontSize: 12 } as const
// This Mac opens localhost; a phone or another computer opens the tailnet link.
const onMac = () => typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)

/** A row per project with a dev script: Dev starts it in the window holding the project; running, it shows its port and links. */
export function DevRows({ dev, tailscale, isVSCode, send }: { dev: DevProject[]; tailscale?: boolean; isVSCode: boolean; send: (c: HubCommand) => void }) {
  const [qr, setQr] = useState<string>()
  if (!dev.length) return null
  const open = (d: DevProject) => {
    const url = isVSCode || onMac() ? `http://localhost:${d.port}` : d.link
    if (!url) return
    if (isVSCode) send({ type: 'hub-open-url', url })
    else window.open(url, '_blank', 'noopener')
  }
  return (
    <section aria-label="Dev servers" style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
      <h3 style={caps}><span>Dev servers</span>{tailscale === false && <span>No Tailscale: this Mac only</span>}</h3>
      <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
        {dev.map(d => {
          const openable = isVSCode || onMac() || !!d.link
          return (
            <li key={d.folder} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
              <span title={d.folder} style={{ color: 'var(--hub-ink)', fontWeight: 500, minWidth: 0, flex: '1 1 80px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.project}</span>
              <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                {d.port
                  ? <>
                      <span className="hub-chip" style={{ color: 'var(--hub-green)', background: 'var(--hub-green-soft)' }}><i aria-hidden />:{d.port}</span>
                      <button type="button" className="hub-btn" style={small} disabled={!openable} onClick={() => open(d)}
                        title={openable ? undefined : 'Not on the tailnet yet: open it on the Mac'}>Open</button>
                      {d.link && <button type="button" className="hub-btn" style={small} aria-expanded={qr === d.folder} onClick={() => setQr(qr === d.folder ? undefined : d.folder)}>Phone</button>}
                      <button type="button" className="hub-btn" style={small} onClick={() => send({ type: 'hub-dev-stop', folder: d.folder })}>Stop</button>
                    </>
                  : <button type="button" className="hub-btn" style={small} title={`${d.command} in ${d.project}`} onClick={() => send({ type: 'hub-dev-start', folder: d.folder })}>
                      <span aria-hidden>▶ </span>Dev
                    </button>}
              </span>
              {qr === d.folder && d.link && (
                <div style={{ flexBasis: '100%', display: 'grid', justifyItems: 'center', gap: 6, padding: '6px 0' }}>
                  <PhoneQr url={d.link} label={`QR code that opens ${d.project} on your tailnet`} />
                  <a href={d.link} target="_blank" rel="noopener" style={{ font: '400 12px/1.4 var(--hub-mono)', color: 'var(--hub-ash)', overflowWrap: 'anywhere', textAlign: 'center' }}>{d.link}</a>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
