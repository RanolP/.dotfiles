export function codexConfig(userConfig, modelAutoCompactTokenLimit) {
  if (!Number.isInteger(modelAutoCompactTokenLimit) || modelAutoCompactTokenLimit <= 0)
    throw new Error(`invalid model_auto_compact_token_limit: ${String(modelAutoCompactTokenLimit)}`)
  const topLevel = userConfig.split(/^\[/m)[0]
  const inherited = topLevel.split('\n').filter(line => /^\s*(model|model_reasoning_effort)\s*=/.test(line))
  return [
    ...inherited,
    `model_auto_compact_token_limit = ${modelAutoCompactTokenLimit}`,
    'web_search = "disabled"',
    // hetero-subagents emits the target repo's AGENTS.md itself; codex's own load would repeat it.
    'project_doc_max_bytes = 0',
    '[agents]', 'enabled = false',
    '[tools]', 'web_search = false',
    '[features]',
    ...['apps', 'plugins', 'memories', 'hooks', 'multi_agent', 'multi_agent_v2', 'image_generation', 'browser_use',
      'browser_use_external', 'computer_use', 'in_app_browser', 'tool_suggest', 'skill_search', 'goals', 'shell_snapshot',
    ].map(feature => `${feature} = false`),
    '',
  ].join('\n')
}

// Every bridge shares one CODEX_HOME, and codex app-server 0.171.0 treats any content write to config.toml (even identical
// bytes) as a configuration change: each live thread holding a custom permissions profile then fails every later turn with
// "failed to load workspace requirements: invalid input parameter". So a starting bridge writes only when the content differs.
export function writeConfigIfChanged(fsApi, configPath, content, pid) {
  let current
  try { current = fsApi.readFileSync(configPath, 'utf8') } catch (err) { if (err?.code !== 'ENOENT') throw err }
  if (current === content) return false
  const temp = `${configPath}.${pid}.tmp`
  fsApi.writeFileSync(temp, content, { mode: 0o600 })
  fsApi.renameSync(temp, configPath)
  return true
}
