'use client'

/**
 * The Hub's state from the extension, and the way back to it.
 * Outside VS Code it polls the standalone app's /hub proxy (lib/hub-remote.ts);
 * with no window behind that either, the dev build answers sample data; the phone app never does,
 * it keeps the last real state and says why it is not live.
 */
import { useCallback, useEffect, useState } from 'react'
import { vscodeBridge, type HubCommand } from '@/lib/vscode-bridge'
import type { HubState } from '@/lib/hub-types'
import { demoApply, demoHub, demoTick, emptyHub } from '@/lib/hub-demo'
import { fetchHub, fetchHubWhy, postCommand } from '@/lib/hub-remote'

const POLL_MS = 2000
const IDLE_POLL_MS = 15000

/** problem: why the last command to the standalone app's hub failed, for the Hub's toast. */
// The app build sets NEXT_PUBLIC_DEMO to "0": a phone must never mistake sample chats for its own.
const DEMO_OK = process.env.NEXT_PUBLIC_DEMO !== '0'

/** down: why the standalone app is not live right now, while it shows the last state it had (or nothing). */
export function useHub(): { hub: HubState; isLive: boolean; isDemo: boolean; isVSCode: boolean; send: (c: HubCommand) => void; problem: { text: string; at: number } | null; down?: string } {
  const [hub, setHub] = useState<HubState | null>(null)
  const [isVSCode, setIsVSCode] = useState(false)
  const [remote, setRemote] = useState<HubState | null>(null)
  const [tried, setTried] = useState(false)
  const [demo, setDemo] = useState<HubState>(() => demoHub())
  const [problem, setProblem] = useState<{ text: string; at: number } | null>(null)
  const [down, setDown] = useState<string>()

  useEffect(() => {
    if (!vscodeBridge) return
    const offInit = vscodeBridge.onInit(() => setIsVSCode(true))
    const offHub = vscodeBridge.onHub(setHub)
    return () => { offInit(); offHub() }
  }, [])

  // Outside VS Code: the standalone app's proxy to a window's hub, every 2 s.
  // With no hub (the demo) it retries every 15 s, so a window that opens later still connects
  // and the console gets one failed fetch per retry instead of one every 2 s.
  useEffect(() => {
    if (isVSCode) return
    let stop = false, t: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      if (vscodeBridge?.isVSCode) return
      // A hidden tab asks nothing; it looks again within 2 s of being shown.
      if (document.hidden) { t = setTimeout(tick, POLL_MS); return }
      const { hub: got, why } = await fetchHubWhy()
      if (stop) return
      // A failed poll keeps the last real state on screen; only the dev build falls back to the demo.
      if (got || !DEMO_OK) setRemote(r => got ?? r)
      else setRemote(null)
      setDown(got ? undefined : why)
      setTried(true)
      t = setTimeout(tick, got ? POLL_MS : DEMO_OK ? IDLE_POLL_MS : POLL_MS)
    }
    void tick()
    return () => { stop = true; clearTimeout(t) }
  }, [isVSCode])

  const isDemo = DEMO_OK && !isVSCode && hub === null && remote === null && tried
  // The demo's working chat keeps calling tools, so the orbit has something to show.
  useEffect(() => {
    if (!isDemo) return
    const t = setInterval(() => { if (!document.hidden) setDemo(d => demoTick(d, Date.now())) }, 900)
    return () => clearInterval(t)
  }, [isDemo])
  const send = useCallback((c: HubCommand) => {
    if (isDemo) setDemo(d => demoApply(d, c))
    else if (!isVSCode && remote) {
      void postCommand(c).then(why => {
        if (why) setProblem({ text: `${c.type.replace('hub-', '')} failed: ${why}`, at: Date.now() })
        return fetchHub()
      }).then(s => s && setRemote(s))
    }
    else vscodeBridge?.sendHub(c)
  }, [isDemo, isVSCode, remote])
  // A window still running an older Switchboard sends fewer fields; missing ones start empty.
  const got = hub ?? (isVSCode ? null : remote)
  const live = got && { ...emptyHub(), ...got }
  return { hub: live ?? (isDemo ? demo : emptyHub()), isLive: live !== null && !down, isDemo, isVSCode, send, problem, down: isVSCode ? undefined : down }
}
