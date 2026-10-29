/**
 * A chat's name from Kenneth's goal, 3 to 5 words, made before the chat starts so
 * `claude --name` can carry it (a running chat cannot rename itself). The quick model
 * call is Claude Code's own Haiku on the subscription; slow or failed, the goal's first words.
 */
const MAX_WORDS = 5
export const TITLE_MS = 20000

const words = (s: string) => s.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean)
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function fallbackTitle(goal: string): string {
  const w = words(goal).slice(0, MAX_WORDS)
  return w.length ? cap(w.join(' ')) : 'New chat'
}

export function cleanTitle(answer: string): string | undefined {
  const w = words(answer.replace(/^\s*title\s*:/i, '')).slice(0, MAX_WORDS)
  return w.length ? cap(w.join(' ')) : undefined
}

/** `ask` gets the wait too, so its model call can be killed when the wait ends. */
export async function titleFor(goal: string, ask: (prompt: string, ms: number) => Promise<string>, ms = TITLE_MS): Promise<string> {
  const prompt = `Name this coding task in 3 to 5 plain words, no quotes, no punctuation. Answer with the name only.\n\nTask: ${goal.slice(0, 600)}`
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>(r => { timer = setTimeout(() => r(undefined), ms) })
  const answer = await Promise.race([ask(prompt, ms).catch(() => undefined), timeout])
  clearTimeout(timer)
  return (answer && cleanTitle(answer)) ?? fallbackTitle(goal)
}
