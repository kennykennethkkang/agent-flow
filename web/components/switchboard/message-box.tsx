'use client'
import { useState } from 'react'
import type { ChatRow } from '@/lib/hub-types'
import type { HubCommand } from '@/lib/vscode-bridge'
import { boxNote } from '@/lib/message-box'

const MAX = 4000

/** Types a message into the shown chat as if Kenneth typed it there. Keyed by chat, so a switch starts empty. */
export function MessageBox({ chat, send, problem }: { chat: ChatRow; send: (c: HubCommand) => void; problem: { text: string; at: number } | null }) {
  const [text, setText] = useState('')
  const [sent, setSent] = useState<{ text: string; at: number }>()
  const note = boxNote(chat)
  const failed = sent && problem && problem.at >= sent.at && problem.text.startsWith('send failed') ? problem.text : undefined
  const go = () => {
    const t = text.trim()
    if (!t || note) return
    send({ type: 'hub-send', sessionId: chat.sessionId, text: t })
    setSent({ text: t, at: Date.now() })
    setText('')
  }
  const codex = chat.ai === 'codex'
  return (
    <form onSubmit={e => { e.preventDefault(); go() }} style={{ display: 'grid', gap: 8, padding: '0 20px 16px' }}>
      <label htmlFor="say" style={{ font: '500 13px/1 var(--hub-sans)', color: 'var(--hub-ink)' }}>Message this chat</label>
      {note
        ? <p role="status" style={{ margin: 0, fontSize: 13, color: 'var(--hub-ash)' }}>{note}</p>
        : <>
            <textarea id="say" rows={2} maxLength={MAX} value={text} onChange={e => setText(e.target.value)} placeholder={`Sent to ${codex ? 'Codex' : 'Claude'} as if you typed it`}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); go() } }}
              style={{ font: 'inherit', padding: 10, borderRadius: 8, resize: 'vertical', background: 'var(--hub-canvas)', color: 'var(--hub-ink)', border: '1px solid var(--hub-hair)' }} />
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span role="status" style={{ minWidth: 0, flex: 1, fontSize: 13, color: failed ? 'var(--hub-red)' : 'var(--hub-ash)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {failed ?? (sent ? `${codex ? 'Typed into its terminal' : 'Queued, picked up within seconds'}: ${sent.text}` : 'Enter sends, Shift+Enter for a new line')}
              </span>
              <button type="submit" className="hub-btn primary" disabled={!text.trim()}>Send ⏎</button>
            </div>
          </>}
    </form>
  )
}
