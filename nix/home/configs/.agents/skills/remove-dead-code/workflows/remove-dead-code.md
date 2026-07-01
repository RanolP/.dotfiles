# Workflow: Remove Dead Code

<required_reading>
**Read these reference files NOW:**
1. references/detection-patterns.md
</required_reading>

<process>

<step_1>
**Verify scan report exists**

Check for `dead-code-report.md` in the project root.

- If it exists: read it and extract high-confidence items
- If it doesn't exist: tell the user to run the scan workflow first and stop

Ask the user:
"The scan found {N} high-confidence and {M} medium-confidence dead code items. What would you like to remove?"

Options:
1. **High confidence only (Recommended)** - Remove only items all agents agreed are dead
2. **High + medium confidence** - Remove all flagged items (review medium items first)
3. **Let me pick** - Show the list and let me select specific items
</step_1>

<step_2>
**Create backup branch**

This step is **mandatory and cannot be skipped**.

```bash
git stash --include-untracked -m "dead-code-removal-stash-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
git branch "backup/dead-code-removal/$(date +%Y%m%d-%H%M%S)"
git stash pop 2>/dev/null || true
```

Confirm the backup branch was created before proceeding. Report the branch name to the user.
</step_2>

<step_3>
**Categorize removals for atomic commits**

Group the confirmed dead code items into removal categories:

1. **Orphaned files** - Entire files to delete
2. **Unused exports** - Remove export keyword or entire function/const
3. **Dead imports** - Remove import statements
4. **Unused dependencies** - Remove from `package.json`
5. **Unreachable code** - Remove dead branches, code after returns

Each category gets its own commit for easy selective reversion.
</step_3>

<step_4>
**Execute removals by category**

For each category, in this order:

**4a. Remove orphaned files**
- Delete entire files that have zero inbound references
- Commit: `refactor: remove {N} orphaned files`
- List removed files in commit body

**4b. Remove unused exports**
- If the entire function/class/const is unused (not just the export): remove the whole declaration
- If only the export is unused but the symbol is used locally: remove only the `export` keyword
- Clean up any now-empty barrel file entries (`index.ts`)
- Commit: `refactor: remove {N} unused exports`

**4c. Remove dead imports**
- Remove import statements for symbols no longer present
- Remove imports for deleted files
- Clean up empty import lines
- Commit: `refactor: remove {N} dead imports`

**4d. Remove unused dependencies**
- Remove from `package.json` dependencies/devDependencies
- Do NOT run `npm install` yet (that happens in validation)
- Commit: `refactor: remove {N} unused dependencies`

**4e. Remove unreachable code**
- Remove functions/variables that lost their only consumer in previous steps
- Remove code after early returns
- Commit: `refactor: remove unreachable code`

After each commit, run `tsc --noEmit` (if TypeScript project) to catch cascading issues early. If errors appear, fix the cascading dead code (items that became dead because their only consumer was just removed).
</step_4>

<step_5>
**Generate removal summary**

Update `dead-code-report.md` with a removal section:

```markdown
## Removal Summary
Backup branch: backup/dead-code-removal/{timestamp}
Commits: {list of commit hashes and messages}

### Removed
- {N} orphaned files deleted
- {N} unused exports removed
- {N} dead imports cleaned up
- {N} unused dependencies removed
- {N} unreachable code blocks removed

### Rollback
To revert all changes:
git reset --hard backup/dead-code-removal/{timestamp}

To revert a specific category:
git revert {commit-hash}
```

Tell the user to run the validate workflow next.
</step_5>

</process>

<success_criteria>
Removal is complete when:
- [ ] Backup branch created and confirmed
- [ ] All confirmed items removed in categorized atomic commits
- [ ] `tsc --noEmit` passes after each commit (if TS project)
- [ ] Removal summary appended to `dead-code-report.md`
- [ ] Rollback instructions provided to user
- [ ] User informed to run validation next
</success_criteria>
