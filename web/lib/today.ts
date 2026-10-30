/** The Today card's numbers, from the live chats, the usage history and the live feeds. */
import type { ChatState, DayUsage, JevRun, SessionLive } from './hub-types'
import { projectName } from './archive'

type Card = { chat: { sessionId: string; name?: string; cwd: string; project?: string }; progress?: { state: ChatState; at: number; question?: string } }
export type Today = { done: string[]; needs: { name: string; question?: string }[]; working: string[]; openCostUsd?: number; tokens?: number; jev?: { runs: number; costUsd: number } }

const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const nameOf = (c: Card) => c.chat.name || projectName(c.chat) || c.chat.sessionId.slice(0, 8)

/**
 * tokens: today's input, output and cache writes from the usage history (cache reads would dwarf them).
 * openCostUsd: what the open chats cost since they started, which may reach back before today; the history has
 * tokens per day but no cost, so the card labels it as the open chats' cost, not today's.
 */
export function todayView(cards: Card[], history: DayUsage[], live: SessionLive[], now = Date.now(), jev: JevRun[] = []): Today {
  const day = dayKey(now)
  const runs = jev.filter(r => dayKey(r.at) === day)
  const usage = history.find(d => d.day === day)
  const costs = live.map(l => l.costUsd).filter((c): c is number => c !== undefined)
  return {
    done: cards.filter(c => c.progress?.state === 'done' && dayKey(c.progress.at) === day).map(nameOf),
    needs: cards.filter(c => c.progress?.state === 'needs-you').map(c => ({ name: nameOf(c), question: c.progress?.question })),
    working: cards.filter(c => c.progress?.state === 'working').map(nameOf),
    openCostUsd: costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100 : undefined,
    tokens: usage && usage.written + usage.io > 0 ? usage.written + usage.io : undefined,
    jev: runs.length ? { runs: runs.length, costUsd: Math.round(runs.reduce((a, r) => a + r.costUsd, 0) * 1e4) / 1e4 } : undefined,
  }
}
