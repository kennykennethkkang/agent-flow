/** Every open Switchboard view's sender (editor panel and sidebar), so hub state reaches all of them. */
export class Posters<M> {
  private readonly senders = new Map<(m: M) => void, () => boolean>()
  get size(): number { return this.senders.size }
  /** The views on screen now; a view VS Code keeps alive while hidden is open but not shown. */
  get shown(): number { return [...this.senders.values()].filter(v => v()).length }
  /** Returns the remover; removing one sender leaves the others. visible: whether that view is on screen. */
  add(send: (m: M) => void, visible: () => boolean = () => true): () => void {
    this.senders.set(send, visible)
    return () => { this.senders.delete(send) }
  }
  /** Only to shown views: a hidden one gets the current state when it shows again. */
  send(m: M): void { for (const [s, v] of this.senders) if (v()) s(m) }
}

/**
 * What the 15 s tick reads. Full (plan, git, servers, changes, chats) while a view shows or the standalone app
 * reads /hub/state; with views open but hidden only what handoffs and closing need (the chats); with no view, nothing.
 */
export function tickWork(shown: number, open: number, appReading: boolean): 'full' | 'essentials' | 'none' {
  if (shown || appReading) return 'full'
  return open ? 'essentials' : 'none'
}
