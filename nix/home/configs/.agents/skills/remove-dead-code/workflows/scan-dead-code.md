# Workflow: Scan for Dead Code

<required_reading>
**Read these reference files NOW:**
1. references/detection-patterns.md
2. references/agent-coordination.md
</required_reading>

<process>

<step_1>
**Gather project context**

Before launching agents, understand the project:

1. Read `package.json` for entry points (`main`, `exports`, `bin`, `types`), scripts, and framework
2. Read `tsconfig.json` for path aliases, `rootDir`, `include`/`exclude` patterns
3. Identify framework conventions:
   - Next.js: `app/`, `pages/`, `middleware.ts`, route handlers
   - Convex: `convex/` directory functions are entry points
   - Express/Fastify: route files, middleware
4. Identify test patterns: `*.test.*`, `*.spec.*`, `__tests__/`, `vitest.config.*`, `jest.config.*`
5. Check for barrel files (`index.ts`) that re-export

Store this context — it will be passed to every scout agent.
</step_1>

<step_2>
**Launch parallel scout agents**

Launch these scout agents in parallel using the Task tool. Each agent gets the project context from Step 1.

**Scout 1: Unused Exports Scanner** (subagent_type: `scout-report-suggest`)
- For every exported symbol (function, class, type, const, enum) in every `.ts`/`.tsx` file
- Search for imports of that symbol across the entire codebase
- Flag exports with zero import references
- Exclude: entry points, `package.json` exports, framework convention files, `.d.ts` files

**Scout 2: Orphaned Files Scanner** (subagent_type: `scout-report-suggest`)
- For every `.ts`/`.tsx` file in `src/`
- Search for any import/require referencing that file path
- Flag files with zero inbound imports
- Exclude: entry points, config files, test files that test other files, route/page files

**Scout 3: Dead Import & Dependency Scanner** (subagent_type: `scout-report-suggest`)
- Find imports where the imported symbol is never used in the importing file
- Find `package.json` dependencies not imported anywhere in source
- Find devDependencies not referenced in test files, configs, or scripts
- Exclude: type-only imports used in type positions, side-effect imports (`import './styles.css'`)

**Scout 4: Unreachable Code Scanner** (subagent_type: `scout-report-suggest`)
- Find unexported functions/variables only used within their own file — then check if THEY are used
- Find functions that are exported but whose only consumer is also dead
- Find code after early returns, unreachable branches
- Exclude: React hooks (may be called conditionally), event handlers assigned via JSX

Pass each scout a prompt containing:
- Project context (entry points, framework, aliases)
- Their specific scanning mission from above
- Instruction to output findings as a structured list: `{file, line, symbol, reason, confidence: high|medium|low}`
</step_2>

<step_3>
**Collect and merge scout results**

Wait for all scouts to complete. Merge their findings into a single candidate list. Deduplicate entries that multiple scouts flagged (these are higher confidence).
</step_3>

<step_4>
**Launch validator agent**

Launch a single validator agent (subagent_type: `scout-report-suggest`) with ALL candidate findings.

The validator must:
1. For each candidate, perform a fresh reference search (Grep for the symbol name across the entire project)
2. Check for dynamic usage patterns: string interpolation, `eval`, `require()` with variables, `Object.keys()` patterns
3. Check for framework-magic usage (Next.js `generateMetadata`, Convex `query`/`mutation` exports, etc.)
4. Check if the symbol appears in any config, build script, or CI file
5. Downgrade confidence or reject candidates that have ANY potential live reference

Output: validated list with `{file, line, symbol, reason, confidence, validator_notes}`
</step_4>

<step_5>
**Generate scan report**

Create a report file at the project root: `dead-code-report.md`

```markdown
# Dead Code Scan Report
Generated: {timestamp}
Branch: {current branch}

## Summary
- Total candidates found: {N}
- High confidence: {N} (safe to remove)
- Medium confidence: {N} (review recommended)
- Low confidence: {N} (kept for safety)

## High Confidence (Safe to Remove)
| File | Line | Symbol | Reason | Scouts |
|------|------|--------|--------|--------|
| ... | ... | ... | ... | ... |

## Medium Confidence (Review Recommended)
| File | Line | Symbol | Reason | Notes |
|------|------|--------|--------|-------|
| ... | ... | ... | ... | ... |

## Excluded (Low Confidence / Safety)
| File | Line | Symbol | Reason | Why Kept |
|------|------|--------|--------|----------|
| ... | ... | ... | ... | ... |

## Next Steps
Run `/remove-dead-code` to safely remove high-confidence items.
Review medium-confidence items manually before including them.
```

Present the report summary to the user.
</step_5>

</process>

<success_criteria>
Scan is complete when:
- [ ] Project context gathered (entry points, framework, aliases)
- [ ] All 4 scout agents completed their analysis
- [ ] Validator agent cross-checked all candidates
- [ ] `dead-code-report.md` generated at project root
- [ ] Report presented to user with summary counts
- [ ] No files were modified (read-only operation)
</success_criteria>
