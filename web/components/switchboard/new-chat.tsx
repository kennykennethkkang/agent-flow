'use client'
import { useState } from 'react'
import type { HubState } from '@/lib/hub-types'
import type { HubCommand } from '@/lib/vscode-bridge'

export function NewChat({ hub, send, onDone }: { hub: HubState; send: (c: HubCommand) => void; onDone: () => void }) {
  const open = hub.projects.find(p => p.isOpen) ?? hub.projects[0]
  const [path, setPath] = useState(open?.path ?? '')
  const [text, setText] = useState('')
  // The extension picks the chat's tools from the goal; the chat's Tools section changes them later.
  const start = () => {
    if (!text.trim() || !path) return
    send({ type: 'hub-new-chat', path, text: text.trim(), remote: hub.rc.atStartup })
    setText('')
    onDone()
  }
  return (
    <form onSubmit={e => { e.preventDefault(); start() }} style={{ display: 'grid', gap: 10, padding: 16, borderRadius: 10, border: '1px solid var(--hub-hair)', background: 'var(--hub-elev)' }}>
      <label htmlFor="goal" style={{ fontWeight: 500, color: 'var(--hub-ink)' }}>What should this chat do?</label>
      <textarea id="goal" autoFocus rows={3} value={text} onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); start() }
          else if (e.key === 'Escape') onDone()
        }} style={{ font: 'inherit', padding: 10, borderRadius: 8, resize: 'vertical', background: 'var(--hub-canvas)', color: 'var(--hub-ink)', border: '1px solid var(--hub-hair)' }} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <label htmlFor="folder" style={{ color: 'var(--hub-ash)' }}>in</label>
        <select id="folder" value={path} onChange={e => setPath(e.target.value)} style={{ font: 'inherit', padding: '7px 10px', borderRadius: 8, minWidth: 0, background: 'var(--hub-canvas)', color: 'var(--hub-ink)', border: '1px solid var(--hub-hair)' }}>
          {hub.projects.map(p => <option key={p.path} value={p.path}>{p.name}</option>)}
        </select>
        <button type="submit" className="hub-btn primary" style={{ marginLeft: 'auto' }}>Start ⏎</button>
      </div>
    </form>
  )
}
