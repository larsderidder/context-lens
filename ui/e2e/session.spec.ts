import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import capture from './fixtures/anthropic-session.json' with { type: 'json' }

let pageErrors: string[]

/** Ingest synthetic traffic through the real analysis API, without calling an LLM. */
async function ingest(request: APIRequestContext, followUp = false) {
  const payload = structuredClone(capture)
  if (followUp) {
    payload.body.messages.push(
      { role: 'assistant', content: 'Synthetic response.' },
      { role: 'user', content: 'Follow-up browser fixture.' },
    )
  }
  const response = await request.post('/api/ingest', { data: payload })
  expect(response.ok()).toBe(true)
}

async function openMessages(page: Page, request: APIRequestContext) {
  await ingest(request)
  await page.getByRole('link', { name: 'Open in inspector' }).click()
  await page.getByRole('button', { name: 'Messages', exact: true }).click()
  await expect(page.locator('.chrono-row')).toHaveCount(3)
}

test.beforeEach(async ({ page, request }) => {
  const reset = await request.post('/api/reset')
  expect(reset.ok()).toBe(true)
  pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('net::ERR_INTERNET_DISCONNECTED')) {
      pageErrors.push(message.text())
    }
  })
  await page.addInitScript(() => {
    localStorage.setItem('context-lens-analytics-consent', 'denied')
  })
  await page.goto('/')
  await expect(page.locator('.connection')).toHaveText('Live')
})

test.afterEach(() => {
  expect(pageErrors).toEqual([])
})

test('the dashboard receives a new session through SSE without reloading', async ({ page, request }) => {
  await expect(page.getByText('No requests captured', { exact: true })).toBeVisible()
  await ingest(request)
  await expect(page.getByRole('link', { name: 'Open in inspector' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'browser-test', exact: true })).toBeVisible()
  await expect(page.locator('.toolbar')).toContainText('1 req')
})

test('Markdown renders while HTML and script links remain inert', async ({ page, request }) => {
  await openMessages(page, request)
  await page.locator('.chrono-row').filter({ hasText: 'Browser fixture' }).click()
  const rendered = page.locator('.detail .md-rendered')
  await expect(rendered.getByRole('heading', { name: 'Browser fixture' })).toBeVisible()
  await expect(rendered.locator('strong')).toHaveText('Markdown works')
  await expect(rendered.getByRole('link', { name: 'safe link' })).toHaveAttribute('href', 'https://example.com')
  await expect(rendered).toContainText('<img src=x onerror="window.injected = true">')
  await expect(rendered.locator('img, script, a[href^="javascript:"]')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).injected)).toBeUndefined()
})

test('Shiki loads its engine and highlights tool results without interpreting HTML', async ({ page, request }) => {
  await openMessages(page, request)
  await page.locator('.chrono-row').filter({ hasText: 'export const message' }).click()
  const highlighted = page.locator('.detail pre.shiki')
  await expect(highlighted).toBeVisible()
  const blocks = capture.body.messages[2].content as { content: string }[]
  await expect(highlighted.locator('code')).toHaveText(blocks[0].content)
  const colors = await highlighted.locator('span[style]').evaluateAll((spans) => {
    return new Set(spans.map((span) => (span as HTMLElement).style.color)).size
  })
  expect(colors).toBeGreaterThan(1)
  await expect(page.locator('.detail img, .detail script')).toHaveCount(0)
})

test('the raw tab shows highlighted, parseable message JSON', async ({ page, request }) => {
  await openMessages(page, request)
  await page.locator('.chrono-row').filter({ hasText: 'Browser fixture' }).click()
  await page.getByRole('button', { name: 'Raw', exact: true }).click()
  const code = page.locator('.detail pre.shiki code')
  await expect(code).toBeVisible()
  const raw = JSON.parse(await code.innerText())
  expect(raw.role).toBe('user')
  expect(raw.content).toBe(capture.body.messages[0].content)
})

test('Splitpanes resizes both panes and enforces their minimum widths', async ({ page, request }) => {
  await openMessages(page, request)
  await page.locator('.chrono-row').filter({ hasText: 'Browser fixture' }).click()
  const panes = page.locator('.messages-tab .splitpanes__pane')
  const splitter = page.locator('.messages-tab .splitpanes__splitter')
  await expect(panes).toHaveCount(2)
  // Wait for Splitpanes' opening transition before measuring the drag target.
  await splitter.hover()
  const before = await panes.first().boundingBox()
  const handle = await splitter.boundingBox()
  expect(before).not.toBeNull()
  expect(handle).not.toBeNull()
  if (!before || !handle) {
    throw new Error('Split panes are not laid out')
  }
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + 150, handle.y + handle.height / 2, { steps: 10 })
  await expect.poll(async () => (await panes.first().boundingBox())?.width ?? 0).toBeGreaterThan(before.width + 50)
  await page.mouse.up()
  await expect(page.locator('.messages-tab .splitpanes')).not.toHaveClass(/splitpanes--dragging/)
  await splitter.hover()

  const movedHandle = await splitter.boundingBox()
  if (!movedHandle) {
    throw new Error('Splitter disappeared after resizing')
  }
  await page.mouse.move(movedHandle.x + movedHandle.width / 2, movedHandle.y + movedHandle.height / 2)
  await page.mouse.down()
  await page.mouse.move(0, movedHandle.y + movedHandle.height / 2, { steps: 10 })
  await expect.poll(async () => panes.first().evaluate((element) => parseFloat((element as HTMLElement).style.width))).toBeCloseTo(25, 0)
  await page.mouse.up()
  const sizes = await panes.evaluateAll((elements) => elements.map((element) => parseFloat((element as HTMLElement).style.width)))
  expect(sizes[0]).toBeCloseTo(25, 0)
  expect(sizes[1]).toBeCloseTo(75, 0)

  await expect(page.locator('.messages-tab .splitpanes')).not.toHaveClass(/splitpanes--dragging/)
  await splitter.hover()
  const leftHandle = await splitter.boundingBox()
  if (!leftHandle) {
    throw new Error('Splitter disappeared at the left boundary')
  }
  await page.mouse.move(leftHandle.x + leftHandle.width / 2, leftHandle.y + leftHandle.height / 2)
  await page.mouse.down()
  await page.mouse.move(1439, leftHandle.y + leftHandle.height / 2, { steps: 10 })
  await expect.poll(async () => panes.last().evaluate((element) => parseFloat((element as HTMLElement).style.width))).toBeCloseTo(25, 0)
  await page.mouse.up()
  const rightSizes = await panes.evaluateAll((elements) => elements.map((element) => parseFloat((element as HTMLElement).style.width)))
  expect(rightSizes[0]).toBeCloseTo(75, 0)
  expect(rightSizes[1]).toBeCloseTo(25, 0)
})

test('live turns update the inspector and remain selectable in the timeline', async ({ page, request }) => {
  await openMessages(page, request)
  await ingest(request, true)
  await expect(page.getByRole('slider')).toHaveAttribute('aria-label', 'Turn scrubber: turn 2 of 2')
  await expect(page.locator('.chrono-row').filter({ hasText: 'Follow-up browser fixture.' })).toBeVisible()
  await page.getByRole('button', { name: 'Timeline', exact: true }).click()
  const bars = page.locator('.timeline-tab .chart-container').first().locator('.bar')
  await expect(bars).toHaveCount(2)
  await bars.first().click()
  await expect(page.getByRole('slider')).toHaveAttribute('aria-label', 'Turn scrubber: turn 1 of 2')
})

test('SSE reconnect catches up with traffic received while the browser was offline', async ({ page, request }) => {
  // Chromium's offline mode does not close an already-open SSE socket.
  // Keep the native transport, but inject its error event to exercise recovery.
  await page.addInitScript(() => {
    const sources: EventSource[] = []
    const NativeEventSource = window.EventSource
    Object.assign(window, { testEventSources: sources })
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options)
        sources.push(this)
      }
    }
  })
  await page.reload()
  await openMessages(page, request)
  await page.context().setOffline(true)
  try {
    await page.evaluate(() => {
      const { testEventSources } = window as unknown as { testEventSources: EventSource[] }
      testEventSources[0].dispatchEvent(new Event('error'))
    })
    await expect(page.locator('.connection')).toHaveText('Offline')
    await ingest(request, true)
  } finally {
    await page.context().setOffline(false)
  }
  await expect(page.locator('.connection')).toHaveText('Live', { timeout: 10000 })
  await expect(page.getByRole('slider')).toHaveAttribute('aria-label', 'Turn scrubber: turn 2 of 2')
  await expect(page.locator('.chrono-row').filter({ hasText: 'Follow-up browser fixture.' })).toBeVisible()
})
