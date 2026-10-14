import { expect, mock, test } from 'claude-code/testing'

// Regression: tab render helpers must resolve their element tags from the mounted surface.
test('the pane renders Text after each dashboard tab is selected', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 100_000, tokens: 25_000, percent: 25 }, rateLimits: [] } }))

  const ui = await $.ui.mount({
    plugin: 'dash',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'dash',
    props: {
      title: 'Dash',
      isFocused: true,
      bodyColumns: 32,
      placement: 'inline',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })

  expect(await ui.find({ type: 'Text' })).toBeDefined()
  for (const tab of ['context', 'fleet', 'usage']) {
    await ui.press({ key: tab })
    expect(await ui.find({ type: 'Text' })).toBeDefined()
  }
})
