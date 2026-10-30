'use client'
import { useEffect, useId, useRef, useState } from 'react'
import type { ChatRow } from '@/lib/hub-types'
import type { HubCommand } from '@/lib/vscode-bridge'
import { projectName } from '@/lib/archive'

type Item = { label: string; done: string; cmd: HubCommand; hint: string }

/** A chat's extra actions behind a "more" button: star, hand off, compact, open its terminal. Arrows move, Esc closes. */
export function ChatMenu({ chat, starred, send, onMac }: { chat: ChatRow; starred: boolean; send: (c: HubCommand) => void; onMac?: boolean }) {
  const [open, setOpen] = useState(false)
  const [said, setSaid] = useState('')
  const id = useId()
  const wrap = useRef<HTMLSpanElement>(null), btn = useRef<HTMLButtonElement>(null)
  const sessionId = chat.sessionId
  const items: Item[] = [
    { label: starred ? 'Unstar' : 'Star', done: starred ? 'Unstarred' : 'Starred', hint: 'Starred chats stay easy to find and resume', cmd: { type: 'hub-star', sessionId, ai: chat.ai ?? 'claude', on: !starred } },
    { label: 'Hand off to a fresh chat', done: 'Handing off', hint: 'Writes a handoff note and carries on in a new chat with the next version number', cmd: { type: 'hub-handoff', sessionId } },
    { label: 'Compact', done: 'Compact queued', hint: 'Asks this chat to compact its context', cmd: { type: 'hub-compact', sessionId } },
    { label: 'Open terminal', done: onMac === false ? 'Opened on the Mac' : 'Opened', hint: onMac === false ? 'Brings up its terminal on the Mac' : 'Brings up its terminal', cmd: { type: 'hub-focus-chat', sessionId } },
  ]
  useEffect(() => { if (!said) return; const t = setTimeout(() => setSaid(''), 1800); return () => clearTimeout(t) }, [said])
  useEffect(() => {
    if (!open) return
    wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const down = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', down)
    return () => document.removeEventListener('pointerdown', down)
  }, [open])
  const key = (e: React.KeyboardEvent) => {
    const all = [...(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const at = all.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current?.focus() }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); all[(at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus() }
    else if (e.key === 'Tab') setOpen(false)
  }
  const name = chat.name ?? projectName(chat)
  return (
    <span ref={wrap} className="hub-more" data-open={open || undefined} onKeyDown={key}>
      <button ref={btn} type="button" className="hub-more-btn" aria-haspopup="menu" aria-expanded={open} aria-controls={id} aria-label={`More for ${name}`} title="More"
        onClick={() => setOpen(!open)}>
        <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="12.5" cy="8" r="1.4" /></svg>
      </button>
      {open && (
        <span id={id} role="menu" aria-label={`Actions for ${name}`} className="hub-menu">
          {items.map(it => (
            <button key={it.cmd.type} type="button" role="menuitem" tabIndex={-1} title={it.hint}
              onClick={() => { send(it.cmd); setSaid(it.done); setOpen(false); btn.current?.focus() }}>{it.label}</button>
          ))}
        </span>
      )}
      <span role="status" className="hub-more-said">{said}</span>
    </span>
  )
}
