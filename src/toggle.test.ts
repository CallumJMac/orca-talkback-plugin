import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

const originalFetch = globalThis.fetch

function captureRequests(): string[] {
  const paths: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    paths.push(new URL(String(url)).pathname)
    return new Response(null, { status: 200 })
  }) as typeof fetch
  return paths
}

function focusOn(workspaceId: string, displayName: string) {
  return { context: { workspaceId, branch: 'main', displayName, terminals: [] } }
}

function status(workspaceId: string, paneKey: string, state: 'working' | 'done' | 'waiting', extra: object = {}) {
  return { workspaceId, paneKey, state, receivedAt: 1, ...extra }
}

function lastStatusBar(worker: Awaited<ReturnType<typeof mountWorker>>) {
  const calls = worker.host.callsOf('statusBar.update')
  return calls[calls.length - 1] as { text?: string; tooltip?: string; tone?: string } | undefined
}

test('muting the workspace on screen stops playback and its replies', async () => {
  const paths = captureRequests()
  try {
    const worker = await mountWorker(main)
    await worker.emit('workspace.changed', focusOn('workspace-1', 'Demo'))
    await worker.command('talkback.toggleHere')
    assert.deepEqual(worker.host.data().storage.muted, ['workspace-1'])
    assert.ok(paths.includes('/stop'))
    paths.length = 0
    await worker.emit('agent.status.changed', status('workspace-1', 'pane-1', 'done'))
    assert.ok(!paths.includes('/status'))
    assert.match(lastStatusBar(worker)?.text ?? '', /🔇/)
    assert.match(lastStatusBar(worker)?.tooltip ?? '', /Demo/)
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('unmuting resumes forwarding', async () => {
  const paths = captureRequests()
  try {
    const worker = await mountWorker(main)
    await worker.emit('workspace.changed', focusOn('workspace-1', 'Demo'))
    await worker.command('talkback.toggleHere')
    await worker.command('talkback.toggleHere')
    assert.deepEqual(worker.host.data().storage.muted, [])
    paths.length = 0
    await worker.emit('agent.status.changed', status('workspace-1', 'pane-1', 'done'))
    assert.ok(paths.includes('/status'))
    assert.match(lastStatusBar(worker)?.text ?? '', /🔊/)
    await worker.deactivate()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the toggle follows the chat you just prompted, as the daemon does', async () => {
  captureRequests()
  try {
    const worker = await mountWorker(main)
    await worker.emit('workspace.changed', focusOn('workspace-sidebar', 'Sidebar workspace'))
    const chat = { workspaceListId: 'identity:chat', title: 'Voice chat' }
    await worker.emit('agent.status.changed', status('workspace-chat', 'chat-pane', 'done', chat))
    await worker.emit('agent.status.changed', status('workspace-chat', 'chat-pane', 'working', chat))
    await worker.command('talkback.toggleHere')
    assert.deepEqual(worker.host.data().storage.muted, ['workspace-chat'])
    assert.match(lastStatusBar(worker)?.tooltip ?? '', /Voice chat/)
    await worker.deactivate()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a muted chat is recognised by either of its workspace ids', async () => {
  const paths = captureRequests()
  try {
    const worker = await mountWorker(main, { host: mockHost({ storage: { muted: ['identity:chat'] } }) })
    paths.length = 0
    await worker.emit('agent.status.changed', status('workspace-chat', 'chat-pane', 'done', { workspaceListId: 'identity:chat' }))
    assert.ok(!paths.includes('/status'))
    await worker.deactivate()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('turning Talkback off everywhere stops playback and forwards nothing', async () => {
  const paths = captureRequests()
  try {
    const worker = await mountWorker(main)
    await worker.emit('workspace.changed', focusOn('workspace-1', 'Demo'))
    await worker.command('talkback.toggleEverywhere')
    assert.equal(worker.host.data().storage.off, true)
    assert.ok(paths.includes('/stop'))
    paths.length = 0
    await worker.emit('workspace.changed', focusOn('workspace-2', 'Other'))
    await worker.emit('agent.status.changed', status('workspace-2', 'pane-2', 'done'))
    assert.deepEqual(paths.filter((path) => path !== '/mutes'), [])
    assert.match(lastStatusBar(worker)?.text ?? '', /off/)
    await worker.command('talkback.toggleEverywhere')
    assert.equal(worker.host.data().storage.off, false)
    await worker.deactivate()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('mutes are remembered across restarts', async () => {
  const paths = captureRequests()
  try {
    const worker = await mountWorker(main, { host: mockHost({ storage: { muted: ['workspace-1'] } }) })
    await worker.emit('workspace.changed', focusOn('workspace-1', 'Demo'))
    paths.length = 0
    await worker.emit('agent.status.changed', status('workspace-1', 'pane-1', 'done'))
    assert.ok(!paths.includes('/status'))
    assert.match(lastStatusBar(worker)?.text ?? '', /🔇/)
    await worker.deactivate()
  } finally {
    globalThis.fetch = originalFetch
  }
})

function captureBodies(): Array<{ path: string; body: unknown }> {
  const requests: Array<{ path: string; body: unknown }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) })
    return new Response(null, { status: 200 })
  }) as typeof fetch
  return requests
}

test('mute settings are sent to the daemon so agents know to write for speaking or reading', async () => {
  const requests = captureBodies()
  try {
    const worker = await mountWorker(main)
    await worker.emit('workspace.changed', focusOn('workspace-1', 'Demo'))
    await worker.command('talkback.toggleHere')
    const mutes = requests.filter((request) => request.path === '/mutes')
    assert.deepEqual(mutes[mutes.length - 1]?.body, { muted: ['workspace-1'], off: false })
    await worker.command('talkback.toggleEverywhere')
    const latest = requests.filter((request) => request.path === '/mutes')
    assert.deepEqual(latest[latest.length - 1]?.body, { muted: ['workspace-1'], off: true })
    await worker.deactivate()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('mute settings reach a restarted daemon with the next event, even while off', async () => {
  const requests = captureBodies()
  try {
    const worker = await mountWorker(main, { host: mockHost({ storage: { off: true } }) })
    requests.length = 0
    await worker.emit('agent.status.changed', status('workspace-1', 'pane-1', 'done'))
    assert.ok(!requests.some((request) => request.path === '/focus' || request.path === '/status'))
    assert.ok(requests.some((request) => request.path === '/mutes'))
    assert.ok(requests.every((request) => JSON.stringify(request.body) === JSON.stringify({ muted: [], off: true })))
    await worker.deactivate()
  } finally {
    globalThis.fetch = originalFetch
  }
})
