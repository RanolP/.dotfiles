# Agent Incidents

Long-form background for the rules in `AGENTS.md` at the repository root. Each entry records a failure that produced a rule, or the detail behind a rule too long to keep in a file that loads into every agent session. Read one after a rule surprises you, or before changing the rule itself.

## 2026-08-31 -- an agent installed packages imperatively instead of editing declarations

Every tool, app and version on this host is declared in exactly one file, so an install performed on the machine is drift that the next rebuild silently reverts or preserves at random.

Asked to find upgradeable software, an agent ran `npm i -g corepack npm pi-subagents` and `brew upgrade`. That left `pi-subagents` at a version no file declared, and it moved `npm` to 12.0.2 under a mise-managed `node = "24.18.0"` that reverts it on the next `mise install`. Meanwhile the flake inputs the agent never looked at were six weeks stale -- and those were the actual upgrade.

The answer to "upgrade X" is to edit the declaration and hand the rebuild over. The three declaration surfaces are also the three places an "what is upgradeable?" report comes from: `mise outdated` for the `[tools]` table of `nix/home/mise-global.toml`, `brew outdated --greedy` for `homebrew.casks` / `homebrew.brews` in `nix/darwin/default.nix`, and the `lastModified` of each `nix flake metadata` input for everything nixpkgs ships. A cask carries no version in the declaration -- nix-homebrew always installs the latest, so a cask upgrade is a `brew upgrade` the rebuild performs, not a version edit.

`declarative-package-guard.py` now denies the imperative form -- `npm i -g`, `pipx install`, `cargo install`, `brew install|upgrade`, `mise use -g`, `nix profile install` -- and names the file to edit instead.

## 2026-08-31 -- a clean dry-run was handed over and the real rebuild died on simple-translate

`nix build ... --dry-run` never downloads anything. It prints the plan and stops. That makes it the right tool for auditing the "will be built" list for a source compile, and completely blind to a fixed-output hash mismatch, an eval error, or a failing builder.

A dry-run was reported clean and the rebuild was handed to the user. It died on `simple-translate`, because `nix/home/darwin/programs/firefox.nix` pinned a fixed hash to the moving `addons.mozilla.org/firefox/downloads/latest/<slug>/latest.xpi` alias, and AMO had published 3.1.0 over the pinned 3.0.1.

Two consequences. First, a hand-pinned AMO addon must name an immutable `/downloads/file/<id>/<name>-<ver>.xpi` URL rather than the `latest.xpi` alias. Second, the check that catches this class of failure is the real build: `cd ~/.dotfiles/nix && nix build .#darwinConfigurations.ranolp-work-MBP-26.system --no-link`. It needs no sudo and produces the exact derivation `darwin-rebuild switch` will activate, so a green run is evidence the handed-over rebuild will work.

## espanso -- why it is fetched as a notarized release rather than built or installed as a cask

espanso is the worked example behind the GOLDEN RULE that no package may be built from source.

In nixpkgs it is source-only on darwin, so taking the nixpkgs package means compiling it. Its Homebrew cask is not an escape either: the cask's nested-dmg unpack is broken under nix-homebrew.

So `nix/home/darwin/default.nix` fetches the official upstream release, then mounts it and `ditto`s the notarized app into `~/Applications` at activation. That is a download, never a compile. The `ditto` step matters for a second reason: unlike a `7zz` unpack, it preserves the code signature. A re-packed bundle triggers a "Espanso is damaged" error at launch, and `codesign` cannot re-seal the bundle inside the nix sandbox.

## 2026-08-27 -- file-edit-guard.py was registered without being deployed and stopped every Bash call

A `PreToolUse` hook on the `Bash` matcher runs in front of every Bash call in every session on this machine, so a bad one is a total work stoppage that only a rebuild can lift.

`file-edit-guard.py` was registered in `nix/home/configs/claude/settings.json` while both its `home.file` entry in `nix/home/default.nix` and its `git add` were missing. Python exited `2` on the absent file, `PreToolUse` read exit `2` as a block, and every Bash call in every session died with `can't open file '/Users/ranolp/.claude/hooks/file-edit-guard.py'`. It stayed broken until the entry was added and the user rebuilt.

Two structural facts caused it. Nix deploys the hooks directory as one explicit entry per script, never by directory recursion, so a new script that is not listed is not deployed. And a flake reads the git tree, so a file that was never `git add`ed is invisible to the rebuild even when it exists on disk.

## The exit-code contract, and what `verify-claude-hook.sh` actually tests

Measured on python 3.14.6 (2026-08-28), a hook's exit status decides what Claude Code does with the call it guards:

- exit `1` -- an uncaught exception. Claude Code treats this as a non-blocking error, so the call proceeds **unguarded**.
- exit `2` -- what a missing script file produces. `PreToolUse` reads exit `2` as a **block**.

That second case is the work stoppage described in the 2026-08-27 incident above.

`./scripts/verify-claude-hook.sh nix/home/configs/claude/hooks/<name>.py` runs the hook against a clean `python:<host-version>-slim` container -- `--network none`, `--read-only`, the repo mounted read-only, no `~/.claude`, no site-packages -- over a battery of real stdin shapes: empty stdin, non-JSON, a JSON array, a `null` / numeric / list `command`, an unterminated heredoc, and a 1MB command.

It grades each result:

- `STOP` -- the hook blocks or hangs every matched call. This is the total work stoppage.
- `OPEN` -- the guard crashed, so the call proceeds unguarded.
- `SLOW` -- the hook is slow enough to notice.

A hook that scores any `STOP` never gets registered.

## 2026-09-22 -- the user rewrote an agent's PR body and cut it to a seventh

Reported from another session working on a CI build-cache fix in a work repository. The user edited the agent's body by hand, showed both versions side by side, and told the agent to send the case here: "내가 고치는 걸 보고 잘 배워서 dotfiles한테 사례집 보내라". The agent's body ran about 2,900 bytes; the user's covered the same scope in about 400, roughly a seventh.

That repo's `.github/PULL_REQUEST_TEMPLATE.md` defines exactly four top-level headers: `## 개요`, `## 작업 내역`, `## 관련 카드`, `## 변경 체크리스트`.

The agent's version opened `## 개요` with five bullets (a measurement, two refuted hypotheses, the scope of application), added a top-level `## 실측 결과` section holding a four-row table plus three paragraphs explaining which number came from what, and wrote `## 작업 내역` as a numbered list of `<short sha> <commit subject>` items, each carrying two or three `리뷰 포인트:` sub-bullets.

The user's version kept the same scope in this shape, with the measurements standing in for the real ones:

```markdown
- CI에서 빌드 캐시가 적용되지 않아 활성화한다.

## 작업 내역

- 캐시 경로만이 문제였으므로 경로를 수정하고 캐시 히트를 확인
- 원격 빌드 캐시를 추가로 사용한다
- 캐시 오염을 막기 위해 버킷을 저장소별로 분리한다

### 실측 결과

- 빌드 시간 : <전> -> <후> (-N%p)
- 캐시 적중 태스크 : <전> -> <후> (-N%p)

증거: 1회차 (링크), 2회차 (링크)
```

Five rules come out of that edit.

**`## 개요` is one line.** It says what was wrong and what was done, nothing else. Four of the agent's five 개요 bullets did not belong there. A refuted hypothesis stays out of the body entirely until a reviewer asks for it.

**No `##` section beyond the ones the repo template names.** The agent created a top-level `## 실측 결과`; the user demoted it to `### 실측 결과` under `## 작업 내역`, saying "실측 결과 <- 이런 섹션은 표준이 아님". Anything extra goes in as a sub-header of an existing section.

**작업 내역 is a list of what was done, not a list of commits.** The user deleted every short sha and every commit subject and cut each item to one line. The reviewer already sees the commit list on the PR screen, so copying it into the body buys nothing. `nix/home/configs/.agents/skills/github-master/guides/pr.md` had asked for one numbered item per commit opening with the short sha and the commit subject; on the same day the user replaced that with one short line per group of commits that does one thing, and set the bar for a `리뷰 포인트:` sub-bullet at "without it a Haiku-level reader could not understand the change".

**A number is one `A -> B (-N%p)` line, not a table.** The agent built a four-row table and the user kept the two load-bearing rows as plain lines. A table earns its place only at three or more columns with a different kind of thing per row.

**Evidence is a `증거: <링크>` line, not commentary.** The agent spent three paragraphs attributing each number to a cause; the user replaced them with the two run links. Whatever the reviewer can confirm by opening the link does not get explained in the body.

One notation to carry verbatim: the user writes a reduction as `-N%p`, using the percentage-point symbol for a ratio change. Write it their way.
