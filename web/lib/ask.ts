import type { AskQuestion, Choice } from './hub-types'

/** The ask card's answer: picks per question, others the typed Other per question (a key means its field is open).
 * Undefined until every question has a pick or Other text. The hub cleans and cuts the text before it is typed. */
export function askChoice(qs: AskQuestion[], picks: Array<number | number[] | undefined>, others: Record<number, string>): Choice | undefined {
  const out: Choice = []
  for (const [n, q] of qs.entries()) {
    const ticked = [picks[n] ?? []].flat()
    if (n in others) {
      const other = others[n].trim()
      if (!other) return undefined
      out.push(q.multiSelect && ticked.length ? { picks: ticked, other } : { other })
    } else if (ticked.length) out.push(q.multiSelect ? ticked : ticked[0])
    else return undefined
  }
  return out
}
