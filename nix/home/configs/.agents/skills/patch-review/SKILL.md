---
name: patch-review
description: Turn any `.patch` / `.diff` file into a readable, pre-rendered Artifact page with one syntax-highlighted diff per file it touches, plus how the patch itself changed when a PR edits an existing one. Use when asked to review or read a patch, when a pull request adds or changes `*.patch` / `*.diff` files (pnpm `patches/`, patch-package, nix `patches = [ ... ]`, `git format-patch` output, Debian quilt), or when a code host shows a patch only as a diff of diff text.
---

# Patch review

A patch file is a diff, so a code host renders a PR that touches it as a diff of diff lines, which nobody can read. This skill renders the patch as the change it applies, with the code-visualizer `patch` block, renders a modified patch as the change in the code it produces, with the `interdiff` block, and publishes the page.

## 1. Collect each patch file

Write every input under one working directory in the scratchpad, one file per patch.

- **GitHub pull request** (`https://github.com/<owner>/<repo>/pull/<n>`):
  1. `gh pr view <n> -R <owner>/<repo> --json files,headRefOid,baseRefOid` and keep the paths ending in `.patch` or `.diff`.
  2. Take the base as the merge base, so unrelated commits on the base branch stay out: `gh api repos/<owner>/<repo>/compare/<baseRefOid>...<headRefOid> --jq .merge_base_commit.sha`.
  3. Fetch the head text: `gh api -H 'Accept: application/vnd.github.raw' "repos/<owner>/<repo>/contents/<path>?ref=<headRefOid>" > head/<file>`.
  4. Fetch the same path at the merge base. A non-zero exit with `HTTP 404` means the PR adds the patch (`gh` still prints the error JSON to stdout, so delete what it wrote); a zero exit means the PR modifies it, so keep the text as `base/<file>`.
  5. A path that 404s at head is a removed patch: fetch it at the merge base and render that.
  6. Pair a version-only rename as one modified patch: when an added and a removed patch name the same package and differ only in the version (`foo@1.2.0.patch` to `foo@1.3.0.patch`, `@scope__foo@1.2.0.patch`, patch-package's `foo+1.2.0.patch`), keep the removed text as `base/<old file>` and the added text as `head/<new file>`. `gh api repos/<owner>/<repo>/pulls/<n>/files` lists a git-detected rename with `status: renamed` and `previous_filename`.
- **Local path**: use the file as it is; for a patch changed in a local branch, `git show <base>:<path> > base/<file>`.
- **URL**: `curl -fsSL <url> -o head/<file>`; for a GitHub blob URL, fetch through the `gh api` contents call above so private repos work.

## 2. Write the spec

One `patch` block per patch file at head, captioned with the patch's repository path. A pnpm or patch-package patch names files relative to the patched package, so the caption carries the package and version (`patches/<pkg>@<version>.patch`) and the reader knows where `src/...` lives.

For each modified patch file, add an `interdiff` block right after it, with `old` the base text and `new` the head text. It shows, per file the patch touches, the code the base version produces against the code the head version produces, which is the part under review when the patch already existed. Both versions patch the same upstream file, so the block aligns their hunks on the upstream line numbers; when the upstream source differs (a package version bump in the file name, or the versions disagree on an upstream line, as with a patch stacked on another patch the PR also changes) it compares hunks in order and says so in its caption. A file only one version patches shows as that version's diff, labelled added or dropped by this PR, and files both versions patch the same way are listed by name.

```json
{"title": "<owner>/<repo>#<n>: patch files",
 "blocks": [
  {"kind": "patch", "path": "head/foo@1.3.0.patch", "caption": "patches/foo@1.3.0.patch"},
  {"kind": "interdiff", "old": "base/foo@1.2.0.patch", "new": "head/foo@1.3.0.patch",
   "caption": "How this PR changes the code patches/foo@1.3.0.patch produces"}]}
```

A removed patch gets a `patch` block on its base text, captioned as removed. Block order follows the PR's file order.

## 3. Render, check, publish

1. `sh ~/.claude/skills/visual-explainer/code-visualizer/render.sh spec.json out.html` from the working directory. A file that holds no file diff stops the render with an error naming it; drop it from the spec and say so in the reply. A `patch` block costs about 35 times the patch's bytes in HTML (a 170 KB patch renders to about 6 MB) and a page may be at most 16 MB, so when the patch files together exceed about 400 KB, write one spec and one page per patch file.
2. Run the code-visualizer gate (`~/.claude/skills/visual-explainer/code-visualizer/README.md` section 5, render loop in `~/.claude/skills/visual-explainer/SKILL.md`): light and dark at 1200 and 400 px, zero `<script>`, `scrollWidth` equal to the viewport width, and one rendered diff per file the patch touches.
3. Publish `out.html` with the Artifact tool, `icon` `code`, and a one-sentence description naming the PR or the patch. Reply with the link and the list of patch files rendered.
