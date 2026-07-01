<overview>
How to coordinate multiple scout agents and a validator agent for dead code analysis. Uses the Task tool to launch parallel agents and merge their results.
</overview>

<agent_architecture>
```
                    +-----------+
                    |  Orchestr |  (you - the main agent)
                    +-----+-----+
                          |
              +-----------+-----------+
              |           |           |
         +----v---+  +----v---+  +---v----+  +----v---+
         |Scout 1 |  |Scout 2 |  |Scout 3 |  |Scout 4 |
         |Exports |  | Files  |  |Imports |  |Unreach |
         +----+---+  +----+---+  +---+----+  +----+---+
              |           |           |           |
              +-----------+-----------+-----------+
                          |
                    +-----v-----+
                    | Validator |
                    +-----------+
                          |
                    +-----v-----+
                    |  Report   |
                    +-----------+
```
</overview>

<launching_scouts>
Launch all 4 scouts simultaneously using the Task tool. Each scout runs as a `scout-report-suggest` subagent (read-only, no modifications).

**Shared context to pass to EVERY scout:**

```
Project: {project name}
Root: {working directory}
Framework: {Next.js/Convex/Express/etc.}
Entry points: {list from package.json}
Path aliases: {from tsconfig.json}
Test patterns: {*.test.*, *.spec.*, __tests__/}
Exclusion patterns: {config files, .d.ts, framework convention files}
```

**Per-scout instructions:**

Each scout gets a specific mission (see scan-dead-code.md Step 2) and must output findings in this format:

```json
{
  "scout": "unused-exports",
  "findings": [
    {
      "file": "src/utils/helpers.ts",
      "line": 42,
      "symbol": "formatCurrency",
      "type": "export",
      "reason": "Zero import references found across project",
      "confidence": "high",
      "search_evidence": "Searched for 'formatCurrency' in all .ts/.tsx files: 0 matches outside defining file"
    }
  ]
}
```
</launching_scouts>

<merging_results>
After all scouts complete:

1. **Collect** all findings into a single list
2. **Deduplicate** by `{file, symbol}` key
3. **Boost confidence** when multiple scouts flag the same item:
   - 1 scout: keep original confidence
   - 2+ scouts: upgrade medium→high, keep high as high
4. **Create candidate list** sorted by confidence (high first, then medium, then low)
</merging_results>

<validator_agent>
Launch one validator agent (subagent_type: `scout-report-suggest`) with the merged candidate list.

**Validator mission:**

For each candidate in the list:

1. **Fresh search**: Grep for the symbol name across ALL project files (not just TS — also check `.md`, `.json`, `.yaml`, `.env`, scripts)
2. **Dynamic usage check**: Search for patterns that could reference the symbol dynamically:
   - Template literals containing the symbol name
   - `Object.keys()`, `Object.values()` on objects containing the symbol
   - `eval()`, `new Function()` patterns
   - Dynamic import: `import('./' + varName)`
3. **Framework check**: Verify the symbol isn't used by framework magic:
   - Next.js: page exports, route handlers, metadata functions
   - Convex: query/mutation/action exports
   - Testing: fixture setup, mock factories
4. **Verdict**: For each candidate, output:
   - `confirmed` — definitely dead, safe to remove
   - `suspicious` — probably dead but has a potential reference worth checking
   - `rejected` — found a live reference, do not remove

**Validator output format:**

```json
{
  "validated": [
    {
      "file": "src/utils/helpers.ts",
      "line": 42,
      "symbol": "formatCurrency",
      "verdict": "confirmed",
      "confidence": "high",
      "notes": "No references in any file type. Not a framework export."
    }
  ]
}
```
</validator_agent>

<error_handling>
- If a scout agent fails or times out: log the failure, proceed with results from other scouts, note reduced coverage in the report
- If the validator agent fails: do NOT proceed with removal — the validator is the safety gate
- If a scout returns zero findings: this is valid (the category may have no dead code)
- If all scouts return zero findings: report "No dead code detected" and exit cleanly
</error_handling>

<performance_tips>
- Scouts are read-only — they can run safely in parallel
- For large projects (1000+ files), scouts should use `Glob` to batch file discovery before `Grep` for references
- Validator can process candidates sequentially — thoroughness matters more than speed here
- Set reasonable timeouts: scouts ~5 minutes each, validator ~10 minutes
</performance_tips>
