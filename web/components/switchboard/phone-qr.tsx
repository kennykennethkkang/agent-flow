'use client'
import { useMemo, useState } from 'react'
import qrcode from 'qrcode-generator'

/** The phone link as a QR, dark on white in both themes so any camera reads it. */
export function PhoneQr({ url, label }: { url: string; label: string }) {
  const { n, d } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(url)
    qr.make()
    const n = qr.getModuleCount()
    let d = ''
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`
    return { n, d }
  }, [url])
  return (
    <svg viewBox={`0 0 ${n + 8} ${n + 8}`} width={180} height={180} role="img" aria-label={label} shapeRendering="crispEdges" style={{ borderRadius: 6 }}>
      <rect width={n + 8} height={n + 8} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  )
}

const originOf = (url: string) => { try { return new URL(url).origin } catch { return url } }

/** The address to type by hand (the IP one too, when the name is first), and the full link (with its secret) to copy;
 * the secret is only needed on a device's first visit. */
export function PhoneAddress({ url, ip, onCopy }: { url: string; ip?: string; onCopy: (text: string) => Promise<boolean> }) {
  const [copied, setCopied] = useState(false)
  return (
    <span style={{ display: 'grid', gap: 6, justifyItems: 'center' }}>
      <code style={{ font: '500 13px/1.3 var(--hub-mono)', color: 'var(--hub-ink)', userSelect: 'all', overflowWrap: 'anywhere', textAlign: 'center' }}>{originOf(url)}</code>
      {ip && <code style={{ font: '400 12px/1.3 var(--hub-mono)', color: 'var(--hub-mute)', userSelect: 'all', overflowWrap: 'anywhere', textAlign: 'center' }}>{originOf(ip)}</code>}
      <button type="button" className="hub-btn" style={{ fontSize: 12, padding: '3px 10px' }} title="The link with its secret: open it once on a new device"
        onClick={() => void onCopy(url).then(ok => { setCopied(ok); if (ok) setTimeout(() => setCopied(false), 1500) })}>{copied ? 'Copied' : 'Copy link'}</button>
    </span>
  )
}
