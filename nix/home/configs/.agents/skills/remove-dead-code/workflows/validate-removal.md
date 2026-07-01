# Workflow: Validate Dead Code Removal

<process>

<step_1>
**Run type checker**

```bash
npx tsc --noEmit
```

If TypeScript errors appear:
- Identify if they are caused by the removal (missing references)
- Fix cascading issues (imports of removed symbols)
- If fixing isn't straightforward, flag for manual review
</step_1>

<step_2>
**Run build**

```bash
npm run build
```

If build fails:
- Check if failure relates to removed code
- Fix build issues caused by removal
- If unrelated to removal, note as pre-existing
</step_2>

<step_3>
**Run tests**

```bash
npm test
```

If tests fail:
- Determine if failures are caused by removal
- For tests that tested removed code: these tests are now dead code too — remove them
- For tests that depended on removed code as utilities: restore the utility or refactor the test
- For unrelated failures: note as pre-existing
</step_3>

<step_4>
**Run linter (if configured)**

```bash
npm run lint 2>/dev/null || true
```

Fix any new lint errors caused by the removal (unused imports in files that imported removed symbols, etc.).
</step_4>

<step_5>
**Final validation report**

Update `dead-code-report.md` with validation results:

```markdown
## Validation Results
- TypeScript: {PASS/FAIL}
- Build: {PASS/FAIL}
- Tests: {PASS/FAIL} ({N} passed, {N} failed, {N} skipped)
- Lint: {PASS/FAIL/SKIPPED}

### Issues Found
{list any issues and how they were resolved}

### Status: {CLEAN / NEEDS REVIEW}
```

Report results to the user:
- If all green: "Dead code removal validated successfully. Backup branch: `{branch}` (safe to delete after confirming)."
- If issues found: "Validation found {N} issues. See report for details. Run `git reset --hard backup/dead-code-removal/{timestamp}` to rollback."
</step_5>

</process>

<success_criteria>
Validation is complete when:
- [ ] TypeScript type check passes
- [ ] Build succeeds
- [ ] All tests pass (or failures documented as pre-existing)
- [ ] Linter passes (or skipped if not configured)
- [ ] Validation results appended to `dead-code-report.md`
- [ ] User informed of final status with rollback instructions
</success_criteria>
