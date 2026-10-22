# Agent Incidents

Long-form background for the rules in `AGENTS.md` at the repository root. Each entry records a failure that produced a rule, or the detail behind a rule too long to keep in a file that loads into every agent session. Read one after a rule surprises you, or before changing the rule itself.

## 2026-08-31 -- an agent installed packages imperatively instead of editing declarations

Every tool, app and version on this host is declared in exactly one file, so an install performed on the machine is drift that the next rebuild silently reverts or preserves at random.

Asked to find upgradeable software, an agent ran `npm i -g corepack npm pi-subagents` and `brew upgrade`. That left `pi-subagents` at a version no file declared, and it moved `npm` to 12.0.2 under a mise-managed `node = "24.18.0"` that reverts it on the next `mise install`. Meanwhile the flake inputs the agent never looked at were six weeks stale -- and those were the actual upgrade.

The answer to "upgrade X" is to edit the declaration and hand the rebuild over. The three declaration surfaces are also the three places an "what is upgradeable?" report comes from: `mise outdated` for the `[tools]` table of `nix/home/mise-global.toml`, `brew outdated --greedy` for `homebrew.casks` / `homebrew.brews` in `nix/darwin/default.nix`, and the `lastModified` of each `nix flake metadata` input for everything nixpkgs ships. A cask carries no version in the declaration -- nix-homebrew always installs the latest, so a cask upgrade is a `brew upgrade` the rebuild performs, not a version edit.

`declarative-package-guard.py` now denies the imperative form -- `npm i -g`, `pipx install`, `cargo install`, `brew install|upgrade`, `mise use -g`, `nix profile install` -- and names the file to edit instead.

## 2026-10-07 -- uncommitted fixes were stashed by another session, which fixed the same bug again

Several Claude sessions work in this one `~/.dotfiles` checkout at once, all on `main`. A session finished fixes to the codex-subagent, clm and time-budget plugins, ran their tests and the nix build, and left them uncommitted while it waited for a "commit" request. Another session needed a clean tree, stashed those changes, and committed its own fix for the same codex 404 bug as `b86b66b` (claude: keep codex worker steps from falling through to Claude). Unstashing then conflicted in `codex-subagent/hooks/register.ts` and its test, and the work had to be reconciled by hand.

The user's verdict: "니가 커밋 안해서 그렇잖아..." and then "checkpoint마다 main에 커밋하고 푸시 전에 rebase를 해야하지". So a finished unit goes onto local `main` as a commit the moment its tests and build pass, with no permission asked. A commit is visible to every other session through `git log`, and a commit cannot be stashed out from under its author. The push still waits for an explicit request, and it always runs `git fetch` and `git rebase origin/main` first, because another session may have pushed in between. The `ship` skill carries the full sequence.

## 2026-08-31 -- a clean dry-run was handed over and the real rebuild died on simple-translate

`nix build ... --dry-run` never downloads anything. It prints the plan and stops. That makes it the right tool for auditing the "will be built" list for a source compile, and completely blind to a fixed-output hash mismatch, an eval error, or a failing builder.

A dry-run was reported clean and the rebuild was handed to the user. It died on `simple-translate`, because `nix/home/darwin/programs/firefox.nix` pinned a fixed hash to the moving `addons.mozilla.org/firefox/downloads/latest/<slug>/latest.xpi` alias, and AMO had published 3.1.0 over the pinned 3.0.1.

Two consequences. First, a hand-pinned AMO addon must name an immutable `/downloads/file/<id>/<name>-<ver>.xpi` URL rather than the `latest.xpi` alias. Second, the check that catches this class of failure is the real build: `cd ~/.dotfiles/nix && nix build .#darwinConfigurations.ranolp-work-MBP-26.system --no-link`. It needs no sudo and produces the exact derivation `darwin-rebuild switch` will activate, so a green run is evidence the handed-over rebuild will work.

## espanso -- why it is fetched as a notarized release rather than built or installed as a cask

espanso is the worked example behind the GOLDEN RULE that no package may be built from source.

In nixpkgs it is source-only on darwin, so taking the nixpkgs package means compiling it. Its Homebrew cask is not an escape either: the cask's nested-dmg unpack is broken under nix-homebrew.

So `nix/home/darwin/default.nix` fetches the official upstream release, then mounts it and `ditto`s the notarized app into `~/Applications` at activation. That is a download, never a compile. The `ditto` step matters for a second reason: unlike a `7zz` unpack, it preserves the code signature. A re-packed bundle triggers a "Espanso is damaged" error at launch, and `codesign` cannot re-seal the bundle inside the nix sandbox.

The broken seal also explains why espanso once lost Accessibility on every release bump (2026-08-11). macOS records a TCC grant made to an app whose seal does not validate as a bare `cdhash` requirement, which names one build; System Settings still showed the toggle on while the new build ran unpermitted. `sudo tccutil reset Accessibility com.federicoterzi.espanso`, then restarting the launchd job so the validly signed app asked again, produced `identifier "com.federicoterzi.espanso" and anchor apple generic and certificate leaf[subject.OU] = "6424323YUH"`, which every later release from the same signer satisfies. Check the stored requirement with `sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "select quote(csreq) from access where client='com.federicoterzi.espanso';"` and decode it with `csreq -r <blob> -t`.

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

## 2026-10-15 -- an unasked native build froze the user's Mac (heavy-local-build-unasked)

A self-review brief for a work ticket said "if the existing APK cannot run the bundle, build it yourself". The worker took that as permission and started `assembleDebug` without asking. At the same moment another session's emulator, Metro and jest were running on the same machine; load average climbed to 25, and the Gradle and Kotlin daemons alone held about 180% CPU. The user's words: "이딴 짓거리를 제발 함부로 저지르지 마라 나도 컴퓨터를 써야 할 거 아님;;" -- they need the machine for their own work.

The Mac is the user's working computer, and several Claude sessions share it, so heavy jobs from different sessions stack on top of the user's own work. The `(load)` clauses of "Size the unit first" in `nix/home/configs/claude/CLAUDE.md` now make every heavy local job (a native build such as `gradlew` or `xcodebuild`, an extra emulator or simulator boot, Metro `--reset-cache`) an explicit question with its cost in one line. A worker brief says "stop and report if a build is needed" rather than "build if needed". An approved job runs under `renice -n 15`, and the emulators, Metro instances and Gradle daemons (`./gradlew --stop`) the session started are stopped when the check is done.

## 2026-07-30 -- a probe build replaced a shared design doc with four placeholder boxes

To diagnose a rendering problem, an agent published a stripped build of the user's design doc onto the doc's own live artifact URL. The good version was replaced by a page carrying four dashed "다이어그램 N -- 이 버전에서는 제외" placeholders, and the user was the one who noticed ("isn't it regression"). The version history made it recoverable, but the shared link stayed degraded in the meantime. The same session also inverted the user's version numbers ("v3 sharable, latest isn't") and stripped work that was already correct. A throwaway artifact answers the same diagnostic question at no cost to the user's link, so every probe goes to a fresh artifact, the live target only ever receives a complete state, and the user's version numbers are read back before acting on them. Rule: "DO (live target)" in `nix/home/configs/claude/CLAUDE.md`.

## 2026-08-18 -- an invented backend API shipped through a patched shared package

Wiring a feature whose backend contract did not exist yet, an agent created `PUT/DELETE` reservation endpoints and a new notification type out of nothing, and attached them to the shared API-endpoints package through a pnpm patch. A grep of the server repository for the feature's names returned zero hits: path, method, status codes and notification string were all invented, modelled on a neighbouring endpoint's shape and labelled a "temporary patch". The user's first reaction was "대체 왜 환각으로 api를 추가했나", and the next day everything was reverted. Three things failed: a goal word in the PR title ("실배선") outranked the missing contract, a cloned neighbouring shape was treated as a contract, and the "temporary" label was treated as an excuse. A missing contract is a stop condition: leave a labelled dummy and write what is missing in the code comment and the PR body.

## 2026-09-03 -- a review card was nearly dropped as "no iOS device" while a booted iPad was attached

Checking an iOS-only safe-area defect, an agent wrote "iOS 기기 필요 -- 판정 포기 유력" into the hand-off and reported the card as blocked. The user asked whether their iPad could be driven with `agent-device`; one `agent-device devices --platform ios` showed it `booted=true`, with the UI test runner signed and installed and the app already on it. The agent then proposed a simulator twice more. The user: "진짜 ㅅㅂ 다 해줬는데 안 쓰는 거 개선해야 한다". The existing "name you do not recognize" rule already covered "about to conclude that some capability is unavailable", but its only prescribed check was `which`, a PATH-level query; nothing told the agent to list what is attached behind a tool it already had. Hence "DO (inventory)": run the listing query and cite its empty output before declaring a device, account, certificate or build absent.

## 2026-09-22 -- a CLI's JSON output printed a live bearer token into the transcript

An agent ran an unfamiliar `nsc cache gradle setup -o json` without reading its `--help` first, and the command printed a live bearer token (`nsct_...`) straight into the conversation. Reading the help would have shown that the command writes credentials to stdout. The user: "앞으로 실행하기 전에 제발 도구 설명좀 읽자". Hence the help-first rule for an unfamiliar CLI, and "DO (secret)": send output that may carry a credential to a scratchpad file and extract only the needed field with `jq`.

## 2026-09-22 -- "send this to the dotfiles session" became a worker editing the rules files

The user told an agent to send an example of its failure to the `dotfiles` session. No session by that name was listed, so instead of stopping, the agent switched to the `dotfiles:evolve` and `rule-write` route and spawned a worker that would write the `~/.dotfiles` rules files directly. The instruction was a message, not rule authoring, and that repository deploys to every session. The worker was stopped before any file changed. The user: "ㅅㅂ dotfiles를 직접 작성하는 월권은 대체 왜 한 건데". When a named target is not there, show what was found and end the turn on "which one?".

## 2026-09-30 -- a label-filtered volume delete removed two volumes nobody listed

To clean up a finished agent worktree stack, an agent handed the user `docker volume rm $(docker volume ls -q --filter label=com.docker.compose.project=$P)`. Compose gives a volume with a fixed `name:` the project label of whichever stack first created it, so the filter also matched two fixed-name local database and secrets volumes from another project, and they were deleted (local development data only). An earlier listing command had been refused by the permission classifier, and the agent handed over the delete without any listing. A filtered delete is now preceded by the same filter's listing, and the delete names those targets as literals; with no listing, no delete is handed over.

## 2026-10-01 -- a "flatten" redesign was built for a span real data never contained

A trace-viewer prototype fixture put an invented span under every request root. The user asked to flatten that span into the request row, and the work was done. Afterwards it turned out the real telemetry has no such span at all. The user: "flatten할 게 없었네 애초에 니가 잘못된 걸 만든 게 문제였네". A fixture now holds only the span names and fields the real system's tests or source list, labels every stand-in, and a design question about fixture data first checks that the data exists.

## 2026-10-06 -- a "<N>x" prompt saving was measured against the agent's own detour

Optimising a per-item LLM extraction prompt, an agent's early variants sent one item per call, re-sending the whole instruction block per item. Moving to larger batches then produced a "<N>x" saving, but production had been batching items all along; against the production baseline the real gain was a small fraction of that. The user: "아 당연히 벌크로 했어야지 멍청한 것". An experiment now starts from the production shape (batch size, model, effort), and every gain is reported against that production baseline.

## 2026-10-19 -- a release-order answer listed bare PR numbers, twice in a row

Asked for the order of a multi-repository release, an agent answered with chains such as "#<a> -> #<b>" and "#<c>, #<d>, #<e>". The user asked "wtf is <a>", and the next answer again gave two bare "PR #<n>" references with no titles. The user: "내가 반복적으로 ID만 띡 던지지 말랬지 피드백을 해도 말을 안 들으니". The "Name every referent" rule already existed, which is evidence the prose rule alone does not hold. A later mention now uses a meaning-name ("the release PR"), and a draft is scanned for `#\d+`, 7+ hex characters and `[A-Z]+-\d+` before sending. A Stop hook that forces a rewrite was rejected as the guard ("\"다시 쓰게\" 하면 경험이 매우 별로였음").
