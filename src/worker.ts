import type { OrcaWorkerApi } from 'orca/worker'

const DAEMON_URL = 'http://127.0.0.1:47823'
const FAILURE_LOG_INTERVAL_MS = 60_000
const REQUEST_TIMEOUT_MS = 3000
const STATUS_BAR_ID = 'talkback'
// A pane moving from one of these into "working" means you just sent it a prompt.
const PROMPTED_FROM_STATES = new Set(['done', 'waiting'])

type Target = { ids: string[]; name: string }
type StatusPayload = { workspaceId: string | null; workspaceListId?: string; paneKey: string; state: string; title?: string }

export default function activate(orca: OrcaWorkerApi) {
  let lastFailureLoggedAt = -Infinity
  let lastFocusPayload: unknown = undefined
  // All POSTs go through one chain so they reach the daemon strictly in event order.
  let deliveryChain: Promise<unknown> = Promise.resolve()
  // What "this workspace" means for the toggle: the workspace picked in the sidebar,
  // or the chat you just prompted, matching how the daemon decides what is on screen.
  let target: Target | null = null
  const paneStates = new Map<string, string>()
  let muted = new Set<string>()
  let offEverywhere = false
  const settingsLoaded = loadSettings()

  async function loadSettings(): Promise<void> {
    const storedMuted = await orca.storage.get('muted')
    muted = new Set(Array.isArray(storedMuted) ? storedMuted.filter((id): id is string => typeof id === 'string') : [])
    offEverywhere = (await orca.storage.get('off')) === true
    void sendMutes()
    await refreshStatusBar()
  }

  function logFailure(message: string): void {
    const now = Date.now()
    if (now - lastFailureLoggedAt >= FAILURE_LOG_INTERVAL_MS) {
      lastFailureLoggedAt = now
      orca.log(message)
    }
  }

  async function forward(path: string, payload: unknown): Promise<boolean> {
    try {
      const response = await fetch(`${DAEMON_URL}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        logFailure(`orca-talkback daemon rejected ${path}: HTTP ${response.status}`)
        return false
      }
      return true
    } catch (error) {
      logFailure(`orca-talkback daemon unreachable: ${String(error)}`)
      return false
    }
  }

  function enqueue(path: string, payload: unknown): Promise<boolean> {
    const delivery = deliveryChain.then(() => forward(path, payload))
    deliveryChain = delivery.catch(() => undefined)
    return delivery
  }

  function sendMutes(): Promise<boolean> {
    // The daemon tells the Claude Code hook whether each session should write a hidden spoken line.
    return enqueue('/mutes', { muted: [...muted], off: offEverywhere })
  }

  function isMuted(ids: Array<string | null | undefined>): boolean {
    return ids.some((id) => typeof id === 'string' && muted.has(id))
  }

  async function refreshStatusBar(): Promise<void> {
    let text = '🔊 Talkback'
    let tone: 'neutral' | 'success' = 'success'
    let tooltip = target ? `Speaking replies from ${target.name}. Click to mute it.` : 'Speaking replies. Click to mute the workspace on screen.'
    if (offEverywhere) {
      text = '🔇 Talkback off'
      tone = 'neutral'
      tooltip = 'Talkback is off everywhere. Run "Talkback: Toggle everywhere" to turn it on.'
    } else if (target && isMuted(target.ids)) {
      text = '🔇 Talkback'
      tone = 'neutral'
      tooltip = `Muted for ${target.name}. Click to unmute.`
    }
    try {
      await orca.host.call('statusBar.update', { id: STATUS_BAR_ID, text, tone, tooltip })
    } catch (error) {
      orca.log(`status bar update failed: ${String(error)}`)
    }
  }

  orca.commands.register('talkback.toggleHere', async () => {
    await settingsLoaded
    if (!target) return 'Open a workspace or send a chat a prompt first.'
    const nowMuted = !isMuted(target.ids)
    if (nowMuted) {
      muted.add(target.ids[0])
      void enqueue('/stop', {})
    } else {
      for (const id of target.ids) muted.delete(id)
    }
    await orca.storage.set('muted', [...muted])
    void sendMutes()
    await refreshStatusBar()
    return nowMuted ? `Talkback muted for ${target.name}.` : `Talkback unmuted for ${target.name}.`
  })

  orca.commands.register('talkback.toggleEverywhere', async () => {
    await settingsLoaded
    offEverywhere = !offEverywhere
    if (offEverywhere) void enqueue('/stop', {})
    await orca.storage.set('off', offEverywhere)
    void sendMutes()
    await refreshStatusBar()
    return offEverywhere ? 'Talkback is off everywhere.' : 'Talkback is on.'
  })

  orca.events.on('workspace.changed', async (payload) => {
    await settingsLoaded
    lastFocusPayload = payload
    const context = payload.context
    target = context?.workspaceId ? { ids: [context.workspaceId], name: context.displayName || 'this workspace' } : null
    await refreshStatusBar()
    if (offEverywhere) return
    await enqueue('/focus', payload)
  })

  orca.events.on('agent.status.changed', async (payload) => {
    await settingsLoaded
    const event = payload as StatusPayload
    const previousState = paneStates.get(event.paneKey)
    paneStates.set(event.paneKey, event.state)
    if (event.state === 'working' && previousState && PROMPTED_FROM_STATES.has(previousState) && event.workspaceId) {
      const ids = [event.workspaceId, event.workspaceListId].filter((id): id is string => typeof id === 'string')
      target = { ids, name: event.title || 'this chat' }
      await refreshStatusBar()
    }
    // Re-sending unchanged settings and focus is a no-op on the daemon, and it survives daemon restarts.
    void sendMutes()
    if (offEverywhere || isMuted([event.workspaceId, event.workspaceListId])) return
    if (lastFocusPayload !== undefined) {
      void enqueue('/focus', lastFocusPayload)
    }
    await enqueue('/status', payload)
  })
}
