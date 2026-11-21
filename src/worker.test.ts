import { assert, mountWorker, test } from 'orca/testing'
import * as main from './worker'

type CapturedRequest = { url: string; body: unknown }

const originalFetch = globalThis.fetch

// Every request the fake receives, in arrival order, including ones it then fails.
let attempted: CapturedRequest[] = []

function captureFetch(
  options: { fail?: boolean; failFirstCalls?: number; status?: number; slowFirstFocusMs?: number } = {},
): CapturedRequest[] {
  const captured: CapturedRequest[] = []
  attempted = []
  let calls = 0
  let slowFocusPending = options.slowFirstFocusMs !== undefined
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls += 1
    attempted.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    if (slowFocusPending && String(url).endsWith('/focus')) {
      slowFocusPending = false
      await new Promise((resolve) => setTimeout(resolve, options.slowFirstFocusMs))
    }
    if (options.fail || calls <= (options.failFirstCalls ?? 0)) throw new Error('connection refused')
    captured.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response(null, { status: options.status ?? 200 })
  }) as typeof fetch
  return captured
}

const focusPayload = {
  context: { workspaceId: 'workspace-1', branch: 'main', displayName: 'Demo', terminals: [] },
}

const statusPayload = {
  workspaceId: 'workspace-1',
  paneKey: 'tab-1:pane-1',
  state: 'done' as const,
  receivedAt: 1,
}

test('forwards focus and status events to the daemon unchanged', async () => {
  const captured = captureFetch()
  try {
    const worker = await mountWorker(main)
    await worker.emit('workspace.changed', focusPayload)
    await worker.emit('agent.status.changed', statusPayload)
    const focusRequests = captured.filter((request) => request.url === 'http://127.0.0.1:47823/focus')
    const statusRequests = captured.filter((request) => request.url === 'http://127.0.0.1:47823/status')
    assert.ok(focusRequests.length >= 1)
    assert.deepEqual(focusRequests[focusRequests.length - 1].body, focusPayload)
    assert.equal(statusRequests.length, 1)
    const statusBody = statusRequests[0].body as Record<string, unknown>
    for (const [key, value] of Object.entries(statusPayload)) {
      assert.deepEqual(statusBody[key], value)
    }
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('resends the remembered focus before a status when the daemon started late', async () => {
  const captured = captureFetch({ failFirstCalls: 2 })
  try {
    const worker = await mountWorker(main)
    // mountWorker delivers an initial workspace.changed (call 1), then ours (call 2): both fail.
    await worker.emit('workspace.changed', focusPayload)
    assert.equal(captured.length, 0)
    assert.ok(attempted.length >= 2)
    assert.ok(attempted.every((request) => request.url === 'http://127.0.0.1:47823/focus'))
    await worker.emit('agent.status.changed', statusPayload)
    assert.deepEqual(
      captured.map((request) => request.url),
      ['http://127.0.0.1:47823/focus', 'http://127.0.0.1:47823/status'],
    )
    assert.deepEqual(captured[0].body, focusPayload)
    await worker.deactivate()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('replays the remembered focus before every status, even after a daemon restart', async () => {
  const captured = captureFetch()
  try {
    const worker = await mountWorker(main)
    await worker.emit('workspace.changed', focusPayload)
    await worker.emit('agent.status.changed', statusPayload)
    await worker.emit('agent.status.changed', statusPayload)
    const statusIndexes = captured.flatMap((request, index) => (request.url.endsWith('/status') ? [index] : []))
    assert.equal(statusIndexes.length, 2)
    for (const statusIndex of statusIndexes) {
      assert.equal(captured[statusIndex - 1].url, 'http://127.0.0.1:47823/focus')
      assert.deepEqual(captured[statusIndex - 1].body, focusPayload)
    }
    await worker.deactivate()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('delivers requests to the daemon strictly in event order', async () => {
  const captured = captureFetch({ slowFirstFocusMs: 50 })
  try {
    const worker = await mountWorker(main)
    const newerFocus = {
      context: { workspaceId: 'workspace-2', branch: 'main', displayName: 'Newer', terminals: [] },
    }
    const firstEmit = worker.emit('workspace.changed', focusPayload)
    const secondEmit = worker.emit('workspace.changed', newerFocus)
    await Promise.all([firstEmit, secondEmit])
    await worker.emit('agent.status.changed', statusPayload)
    const focusBodies = attempted.filter((request) => request.url.endsWith('/focus')).map((request) => request.body)
    const olderIndex = focusBodies.findIndex((body) => JSON.stringify(body) === JSON.stringify(focusPayload))
    const newerIndex = focusBodies.findIndex((body) => JSON.stringify(body) === JSON.stringify(newerFocus))
    assert.ok(olderIndex >= 0 && newerIndex > olderIndex)
    assert.deepEqual(focusBodies[focusBodies.length - 1], newerFocus)
    assert.ok(captured.length >= 3)
    await worker.deactivate()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('logs an unreachable daemon at most once a minute', async () => {
  captureFetch({ fail: true })
  try {
    const worker = await mountWorker(main)
    for (let attempt = 0; attempt < 3; attempt++) {
      await worker.emit('agent.status.changed', statusPayload)
    }
    assert.equal(worker.logs.filter((line) => line.includes('unreachable')).length, 1)
    await worker.deactivate()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('logs a non-2xx response once', async () => {
  captureFetch({ status: 500 })
  try {
    const worker = await mountWorker(main)
    for (let attempt = 0; attempt < 3; attempt++) {
      await worker.emit('agent.status.changed', statusPayload)
    }
    assert.equal(worker.logs.filter((line) => line.includes('HTTP 500')).length, 1)
    await worker.deactivate()
  } finally {
    globalThis.fetch = originalFetch
  }
})
