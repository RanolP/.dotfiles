export function codexConfig(userConfig, modelAutoCompactTokenLimit) {
  if (!Number.isInteger(modelAutoCompactTokenLimit) || modelAutoCompactTokenLimit <= 0)
    throw new Error(`invalid model_auto_compact_token_limit: ${String(modelAutoCompactTokenLimit)}`)
  const topLevel = userConfig.split(/^\[/m)[0]
  const inherited = topLevel.split('\n').filter(line => /^\s*(model|model_reasoning_effort)\s*=/.test(line))
  return [
    ...inherited,
    `model_auto_compact_token_limit = ${modelAutoCompactTokenLimit}`,
    'web_search = "disabled"',
    '[tools]', 'web_search = false',
    '[features]',
    ...['apps', 'plugins', 'memories', 'hooks', 'multi_agent', 'multi_agent_v2', 'image_generation', 'browser_use',
      'browser_use_external', 'computer_use', 'in_app_browser', 'tool_suggest', 'skill_search', 'goals', 'shell_snapshot',
    ].map(feature => `${feature} = false`),
    '',
  ].join('\n')
}
