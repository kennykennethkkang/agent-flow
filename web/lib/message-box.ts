import type { ChatRow } from './hub-types'

/** Why the message box cannot reach a chat, shown in place of it; none when it can. */
export function boxNote(chat: ChatRow): string | undefined {
  if (chat.takes) return undefined
  if (!chat.live) return 'This chat is not running, so messages cannot reach it.'
  return chat.ai === 'codex'
    ? 'This Codex chat was not started or resumed from Switchboard in this window, or has quit, so messages cannot reach it. Type in its terminal.'
    : 'This chat is not collecting messages: it is not running, or the usage-meter mod is not on in it. Type in its terminal.'
}
