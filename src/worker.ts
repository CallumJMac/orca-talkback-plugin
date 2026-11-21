import type { OrcaWorkerApi } from 'orca/worker'

const DAEMON_URL = 'http://127.0.0.1:47823'
const FAILURE_LOG_INTERVAL_MS = 60_000
const REQUEST_TIMEOUT_MS = 3000

export default function activate(orca: OrcaWorkerApi) {
  let lastFailureLoggedAt = -Infinity
  let lastFocusPayload: unknown = undefined
  // All POSTs go through one chain so they reach the daemon strictly in event order.
  let deliveryChain: Promise<unknown> = Promise.resolve()

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

  orca.events.on('workspace.changed', async (payload) => {
    lastFocusPayload = payload
    await enqueue('/focus', payload)
  })
  orca.events.on('agent.status.changed', async (payload) => {
    // Re-sending an unchanged focus is a no-op on the daemon, and it survives daemon restarts.
    if (lastFocusPayload !== undefined) {
      void enqueue('/focus', lastFocusPayload)
    }
    await enqueue('/status', payload)
  })
}
