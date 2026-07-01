<overview>
Patterns for detecting dead code in TypeScript/JavaScript projects. Each pattern includes what to search for, how to confirm it's dead, and what to exclude.
</overview>

<unused_exports>
**What:** Exported symbols (functions, classes, types, constants, enums) with zero import references outside their own file.

**How to detect:**
1. Find all `export` declarations: `export function`, `export const`, `export class`, `export type`, `export interface`, `export enum`, `export default`
2. For each exported symbol, grep the entire project for imports of that symbol
3. Check barrel files (`index.ts`) — an export re-exported through a barrel counts as a reference only if the barrel's re-export is itself imported

**Exclude from flagging:**
- Symbols in entry point files (`main.ts`, `index.ts` at root, files in `package.json` exports/main/bin)
- Framework convention exports: Next.js `default` exports in `app/` and `pages/`, `generateMetadata`, `generateStaticParams`, route handlers (`GET`, `POST`, etc.)
- Convex function exports: `query`, `mutation`, `action`, `internalQuery`, `internalMutation`, `internalAction`, `httpAction` in `convex/` directory
- Types/interfaces in `.d.ts` declaration files
- Symbols with `@public` or `@api` JSDoc tags
</unused_exports>

<orphaned_files>
**What:** Files with zero inbound imports from any other file in the project.

**How to detect:**
1. List all `.ts`/`.tsx`/`.js`/`.jsx` files
2. For each file, search for import/require statements referencing that file path (with or without extension, with path aliases resolved)
3. Flag files with zero inbound references

**Exclude from flagging:**
- Entry points: files referenced in `package.json` (main, exports, bin, types)
- Framework files: Next.js pages/routes, `layout.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`, `middleware.ts`
- Convex files: all files in `convex/` directory (they're entry points by convention)
- Config files: `*.config.*`, `*.setup.*`, `.env*`
- Type declarations: `*.d.ts`
- Test files: only flag if they test a file that was also flagged as orphaned
- Scripts: files referenced in `package.json` scripts
</orphaned_files>

<dead_imports>
**What:** Import statements where the imported symbol is never referenced in the importing file.

**How to detect:**
1. For each import statement, extract imported symbols
2. Search the rest of the file for usage of each symbol
3. Flag symbols that appear only in the import line

**Exclude from flagging:**
- Side-effect imports: `import './polyfill'`, `import 'styles.css'`
- Type-only imports used in type positions: `import type { Foo }` where `Foo` appears in type annotations
- React component imports used in JSX: `<ComponentName />`
- Imports used in decorators or metadata
</dead_imports>

<unused_dependencies>
**What:** `package.json` dependencies not imported anywhere in source code.

**How to detect:**
1. List all dependencies and devDependencies from `package.json`
2. For each dependency, search for `import ... from '{dep}'` or `require('{dep}')` across the project
3. Also check for sub-path imports: `import ... from '{dep}/subpath'`
4. Flag dependencies with zero import references

**Exclude from flagging:**
- Dependencies used in config files: `postcss.config`, `tailwind.config`, `next.config`, `vite.config`, etc.
- CLI tools used in `package.json` scripts: `typescript`, `eslint`, `prettier`, `vitest`, etc.
- Peer dependencies of other installed packages
- Build tool plugins: `@vitejs/plugin-react`, `postcss-*`, etc.
- Type packages (`@types/*`) — check if corresponding package is used
</unused_dependencies>

<unreachable_code>
**What:** Code that can never execute: code after unconditional returns, dead branches, unused private functions.

**How to detect:**
1. Functions/methods that are not exported AND have zero references within their file
2. Code after `return`, `throw`, `break`, `continue` with no conditional wrapping
3. `if (false)` or `if (true) { ... } else { /* this is dead */ }` with literal conditions
4. Switch cases that can never match (when all possible values are covered by earlier cases)

**Exclude from flagging:**
- React hooks (may look unused but are called by React)
- Event handler functions assigned via JSX props
- Functions passed as callbacks to framework methods
- Intentional dead code marked with `// TODO`, `// FIXME`, or `// @keep` comments
</unreachable_code>

<cascading_dead_code>
**What:** Code that becomes dead only after other dead code is removed.

**How to detect:**
After initial removal:
1. Re-scan for newly orphaned files (files whose only consumer was just removed)
2. Re-scan for newly unused exports (exports whose only importer was just removed)
3. Re-scan for dead imports (imports of just-removed symbols)

**Strategy:** Run detection in waves until no new dead code is found. Typically converges in 2-3 waves.
</cascading_dead_code>

<confidence_levels>
**High confidence** — Safe to auto-remove:
- Zero references found by multiple independent searches
- Not in any exclusion category
- Multiple scouts agreed

**Medium confidence** — Human review recommended:
- Only one scout flagged it
- Symbol name is generic (could be referenced dynamically)
- File is in a utility/shared directory
- Validator found a potential but unconfirmed reference

**Low confidence** — Keep for safety:
- Symbol could be used via dynamic import or string lookup
- File matches a framework convention pattern
- Used in test setup or fixtures
- Has JSDoc indicating public API intent
</confidence_levels>
