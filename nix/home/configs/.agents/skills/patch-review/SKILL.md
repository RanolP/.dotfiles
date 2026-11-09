---
name: patch-review
description: Turn any `.patch` / `.diff` file into a readable, pre-rendered Artifact page with one syntax-highlighted diff per file it touches, plus how the patch itself changed when a PR edits an existing one. Use when asked to review or read a patch, when a pull request adds or changes `*.patch` / `*.diff` files (pnpm `patches/`, patch-package, nix `patches = [ ... ]`, `git format-patch` output, Debian quilt), or when a code host shows a patch only as a diff of diff text.
---

# Patch review

A patch file is a diff, so a code host renders a PR that touches it as a diff of diff lines, which nobody can read. This skill renders the patch as the change it applies, with the code-visualizer `patch` block, and publishes the page.

## 1. Collect each patch file

Write every input under one working directory in the scratchpad, one file per patch.

- **GitHub pull request** (`https://github.com/<owner>/<repo>/pull/<n>`):
  1. `gh pr view <n> -R <owner>/<repo> --json files,headRefOid,baseRefOid` and keep the paths ending in `.patch` or `.diff`.
  2. Take the base as the merge base, so unrelated commits on the base branch stay out: `gh api repos/<owner>/<repo>/compare/<baseRefOid>...<headRefOid> --jq .merge_base_commit.sha`.
  3. Fetch the head text: `gh api -H 'Accept: application/vnd.github.raw' "repos/<owner>/<repo>/contents/<path>?ref=<headRefOid>" > head/<file>`.
  4. Fetch the same path at the merge base. A non-zero exit with `HTTP 404` means the PR adds the patch (`gh` still prints the error JSON to stdout, so delete what it wrote); a zero exit means the PR modifies it, so keep the text as `base/<file>`.
  5. A path that 404s at head is a removed patch: fetch it at the merge base and render that.
- **Local path**: use the file as it is; for a patch changed in a local branch, `git show <base>:<path> > base/<file>`.
- **URL**: `curl -fsSL <url> -o head/<file>`; for a GitHub blob URL, fetch through the `gh api` contents call above so private repos work.

## 2. Write the spec

One `patch` block per patch file at head, captioned with the patch's repository path. A pnpm or patch-package patch names files relative to the patched package, so the caption carries the package and version (`patches/<pkg>@<version>.patch`) and the reader knows where `src/...` lives.

For each modified patch file, add a `diff` block right after it, with `old` the base text, `new` the head text, and `name` ending in `.diff` so it highlights as a diff. That block shows what the PR changed in the patch itself, which is the part under review when the patch already existed.

```json
{"title": "<owner>/<repo>#<n>: patch files",
 "blocks": [
  {"kind": "patch", "path": "head/foo@1.2.3.patch", "caption": "patches/foo@1.2.3.patch"},
  {"kind": "diff", "old": "base/foo@1.2.3.patch", "new": "head/foo@1.2.3.patch",
   "name": "patches/foo@1.2.3.patch.diff", "caption": "How this PR changes the patch"}]}
```

A removed patch gets a `patch` block on its base text, captioned as removed. Block order follows the PR's file order.

## 3. Render, check, publish

1. `sh ~/.claude/skills/visual-explainer/code-visualizer/render.sh spec.json out.html` from the working directory. A file that holds no file diff stops the render with an error naming it; drop it from the spec and say so in the reply.
2. Run the code-visualizer gate (`~/.claude/skills/visual-explainer/code-visualizer/README.md` section 5, render loop in `~/.claude/skills/visual-explainer/SKILL.md`): light and dark at 1200 and 400 px, zero `<script>`, `scrollWidth` equal to the viewport width, and one rendered diff per file the patch touches.
3. Publish `out.html` with the Artifact tool, `icon` `code`, and a one-sentence description naming the PR or the patch. Reply with the link and the list of patch files rendered.
