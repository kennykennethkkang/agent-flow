/**
 * What Kenneth sees when a chat finishes or asks something: a VS Code notification,
 * a macOS one with a sound, and on Done the commit message in Source Control. Best effort:
 * a failure here never touches the chat. The phone push comes from the chat itself (rules.md).
 */
import * as vscode from 'vscode'
import { execFile } from 'child_process'
import { hub } from './hub-service'
import { focusChat } from './actions'
import { canPrefill, notifyStep, plainText } from './progress'
import type { ChatProgress, ChatState } from './types'

const titleOf = (p: ChatProgress) => hub.get().chats.find(c => c.sessionId === p.sessionId)?.name ?? p.cwd.split(/[\\/]/).pop() ?? 'A chat'

function mac(title: string, text: string): void {
  if (process.platform !== 'darwin') return
  const q = (s: string) => JSON.stringify(plainText(s))
  execFile('osascript', ['-e', `display notification ${q(text)} with title ${q('Switchboard')} subtitle ${q(title)} sound name "Glass"`], () => {})
}

// Repo root to the message Switchboard last put in its box; anything else there is Kenneth's.
const written = new Map<string, string>()
// Session to what it was last notified about, so a repeat Done or question shows once.
const notified = new Map<string, string>()

/** The commit message into the Source Control box of the repo that holds the chat's folder. */
function prefill(cwd: string, message: string): void {
  try {
    const git = vscode.extensions.getExtension<{ getAPI(v: 1): { repositories: { rootUri: vscode.Uri; inputBox: { value: string } }[] } }>('vscode.git')?.exports?.getAPI(1)
    const repo = git?.repositories.filter(r => cwd === r.rootUri.fsPath || cwd.startsWith(r.rootUri.fsPath + '/')).sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0]
    if (!repo || !canPrefill(repo.inputBox.value, written.get(repo.rootUri.fsPath))) return
    repo.inputBox.value = message
    written.set(repo.rootUri.fsPath, message)
  } catch { /* no git extension: Copy on the card still works */ }
}

export function notify(change: { from?: ChatState; to: ChatProgress }): void {
  const p = change.to
  const n = notifyStep(notified.get(p.sessionId), p)
  if (n.key === undefined) notified.delete(p.sessionId)
  else notified.set(p.sessionId, n.key)
  if (!n.show) return
  const title = titleOf(p)
  if (p.state === 'done') {
    if (p.commit) prefill(p.cwd, p.commit)
    mac(title, 'Done')
    void vscode.window.showInformationMessage(`Switchboard: ${title} is done.`, 'Show').then(c => c && focusChat(p.sessionId))
  } else if (p.state === 'needs-you') {
    mac(title, p.question ?? 'Needs you')
    void vscode.window.showWarningMessage(`Switchboard: ${title} asks: ${p.question ?? 'needs you'}`, 'Answer').then(c => c && focusChat(p.sessionId))
  }
}
