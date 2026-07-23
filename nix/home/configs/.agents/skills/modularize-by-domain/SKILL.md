---
name: modularize-by-domain
description: Group code by business domain, never by technical kind. Use when refactoring or restructuring a codebase, creating new folders/modules, deciding where a new file goes, or reviewing a structure proposal. Triggers on module layout, folder structure, "where should this live", or plans that add folders like components/, store/, hooks/, services/.
---

# modularize-by-domain

**Rule**: group code by business domain (checkout, auth, catalog) — what it does for the user — never by technical kind (`components/`, `store/`, `hooks/`, `services/`, `atoms/`). Common Closure Principle: files that change together live together.

Why kind-grouping fails:

- One feature change fans out across N folders (shotgun surgery).
- Everything must be exported/public to cross folder boundaries.
- The tree screams the framework, not the product.

## Procedure (refactor or greenfield)

1. List recent changes/tickets — each names a domain. Name domains in the business's language.
2. Move ALL artifacts of one domain into its module: UI, state, API, validation, tests. Migrate one domain at a time; keep the app green between moves.
3. Inside a module, technical subfolders are fine — domain first, layer second.
4. Each module exposes one public entry point; other domains import only that, never internals.
5. Shared code: extract to `shared/` only at the third consumer (rule of three); tolerate duplication until then.

## Verification

Pick 3 recent user-facing changes — each should touch exactly one domain module plus at most `shared/`. Folder names should be readable by a non-programmer at the business.

## Constraints

- NEVER create `common/`, `utils/`, or `helpers/` dumping grounds.
- NEVER add a top-level folder named after a library or code kind.
- Flat is fine below ~15 files; don't modularize a tiny project.
- A Redux slice per feature is fine — the anti-pattern is a global `slices/` folder collecting every domain's state.
