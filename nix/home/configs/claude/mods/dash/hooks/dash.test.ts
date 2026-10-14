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
  for (const tab of ['context', 'fleet', 'clm', 'usage']) {
    await ui.press({ key: tab })
    expect(await ui.find({ type: 'Text' })).toBeDefined()
  }
})

// Regression: the Clm tab failed to render and log a useful error when clm was unavailable.
test('the Clm tab renders a logged error when clm is unavailable', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const logs: string[] = []
  on('ui.log', (_$, e) => { logs.push(e.text); return { value: undefined } })

  const ui = await $.ui.mount({
    plugin: 'dash',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'dash',
    props: {
      title: 'Dash',
      isFocused: true,
      bodyColumns: 60,
      placement: 'inline',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })

  await ui.press({ key: 'clm' })
  expect(await ui.find({ type: 'Text', text: /clm is unavailable: .+/ })).toBeDefined()
  expect(logs.some(message => message.startsWith('[dash] clm.status:'))).toBe(true)
})
