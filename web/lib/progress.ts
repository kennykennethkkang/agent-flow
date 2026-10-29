/** Task progress for the chat cards and the Today card. A chat with no task list counts for nothing. */
type Card = { progress?: { tasks: { status: string }[] } }
export type TaskTotals = { done: number; total: number; chats: number; text: string }

export function taskTotals(cards: Card[]): TaskTotals {
  const lists = cards.map(c => c.progress?.tasks ?? []).filter(t => t.length)
  const total = lists.reduce((n, t) => n + t.length, 0)
  const done = lists.reduce((n, t) => n + t.filter(x => x.status === 'completed').length, 0)
  const chats = lists.length
  const text = total ? `${done} of ${total} task${total === 1 ? '' : 's'} done${chats > 1 ? ` across ${chats} chats` : ''}` : ''
  return { done, total, chats, text }
}
