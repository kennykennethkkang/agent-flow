'use client'
import { useMemo } from 'react'
import qrcode from 'qrcode-generator'
import { phoneNetwork } from '@/lib/hub-remote'

/** The phone link as a QR, dark on white in both themes so any camera reads it. */
export function PhoneQr({ url, label }: { url: string; label?: string }) {
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
    <svg viewBox={`0 0 ${n + 8} ${n + 8}`} width={180} height={180} role="img" aria-label={label ?? `QR code that opens Switchboard on your phone (${phoneNetwork(url)})`} shapeRendering="crispEdges" style={{ borderRadius: 6 }}>
      <rect width={n + 8} height={n + 8} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  )
}
