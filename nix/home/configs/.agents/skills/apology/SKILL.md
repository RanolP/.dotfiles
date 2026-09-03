---
description: Claude records one of its own mistakes as a 시말서 (Korean incident report). Restore the offending call verbatim from the session transcript, write self-critically with no excuses, and propose a concrete change in ~/.dotfiles as the recurrence guard. The file stays inside .apologies/ and never leaves the machine.
when_to_use: The user says "/시말서", "시말서", "시말서 써", or "apology", or asks Claude to record a mistake it just made. Use it only for Claude's own mistakes, never for a human's.
---

# 시말서

Record one mistake Claude itself made, together with everything needed to stop it recurring. The purpose differs from a human's 시말서: not apology, but **leaving behind the information that keeps the same mistake from happening again**.

## 0. No leaks — this outranks every other rule

A 시말서 is an extremely specific record of an incident. Code fragments, branch names, ticket numbers, internal paths, and the user's own words go in verbatim. That concreteness is the point, and it is also why the leak risk is extreme: a record built out of real internal detail leaks real internal detail.

- A 시말서 file exists only inside `~/.dotfiles/.apologies/`. That path is in `.gitignore`, and the `apology-leak-guard.py` PreToolUse hook denies any attempt to move it out.
- Keep 시말서 content out of PR bodies, issues, commit messages, Slack messages, Jira/Confluence, Artifacts, and web requests.
- Keep 시말서 content out of subagent briefs. The main thread writes the 시말서 itself.
- Show the user a summary in the terminal response only. The full text lives in the file.
- The first line of every 시말서 file is the sentinel below. The hook detects leaks by this string.

```
<!-- APOLOGY-CONFIDENTIAL / 시말서: 외부 채널 반출 금지 -->
```

## 1. Fix the target incident

- With an argument (`/시말서 강제 푸시 건`), write about that incident.
- With no argument, find the most recent mistake Claude made in this session yourself. Ask the user once only when two or more candidates are genuinely tied.
- Write one incident per file. Several incidents mean several files.

## 2. Restore the evidence

The transcript is the primary evidence. Do not rely on memory.

1. Find the session file. The path is `~/.claude/projects/<slugified cwd>/<session-id>.jsonl`. The slug replaces `/` in the absolute path with `-` (`/Users/ranolp/.dotfiles` → `-Users-ranolp--dotfiles`). When the session ID is unknown, the **most recently modified** `.jsonl` in that directory is the current session.
2. Extract the offending call verbatim. Quote the command text, file paths, and parameters from the `tool_use` entry untouched.
3. Read around it to find the **trigger condition**: what you saw that led to the action, which rule you skipped, what you failed to check.
4. Find when the user pointed it out and count the **detection lag** in turns.
5. Add git evidence when it exists: `git log`, `git reflog`, `git diff`.

Write `확인 불가` for anything the transcript does not confirm, rather than filling it in by guess.

## 3. Check whether it is a repeat

Search `.apologies/` by the name of the violated rule.

```
grep -l "위반한 규칙" ~/.dotfiles/.apologies/*.md
```

When a 시말서 for the same rule already exists:

- Write the earlier 시말서's filename and date at the top of the new document, and state that its recurrence guard failed.
- This time the recurrence guard **must not be a prose rule**. A rule already proved unable to stop it, so propose a machine-checked guard (a PreToolUse hook, a CI check).
- Mark the repeat count as `N차 재발`.

## 4. Write the document

File: `~/.dotfiles/.apologies/YYMMDD-slug.md` (e.g. `260812-force-push-proposal.md`). The slug is lowercase-latin hyphenated text that identifies the incident.

```markdown
<!-- APOLOGY-CONFIDENTIAL / 시말서: 외부 채널 반출 금지 -->

# 시말서 — <사건 한 줄>

## 사건 정보

| 항목 | 내용 |
|---|---|
| 사건 | <한 문장> |
| 발생 | <YYYY-MM-DD HH:MM> |
| 작성 | <YYYY-MM-DD HH:MM> |
| 세션 | <session-id> |
| 재발 | <초범 / N차 재발 — 이전: YYMMDD-slug.md> |

**위반한 규칙**

> <AGENTS.md / CLAUDE.md에서 어긴 줄을 그대로 인용>

**문제의 호출 (원문)**

```
<트랜스크립트에서 그대로 가져온 도구 호출>
```

**발동 조건**

- <그 행동을 하게 만든 직전 상태를 한 줄씩>

**피해 범위**

<무엇이 망가졌는가. 망가지지 않았으면 왜 안 망가졌는가 — 운이었는지 가드였는지 명시.>

**적발자**

<사용자 / 가드 훅 / Claude 자신 — 사람이 먼저 봤으면 그것 자체가 별도의 실패다.>

**감지 지연**

<N턴 / 확인 불가>

## 경위

<시간 순으로. 각 문장은 "나는 ~했다" 형태의 능동태.>

## 원인

<왜 그랬는지. 아래 톤 규칙을 지킨다.>

## 재발 방지 대책

<~/.dotfiles의 구체적 변경 하나. 파일 경로와 내용까지 적는다. 제안만 하고 적용하지 않는다.>
```

## 5. Tone — no self-defense

Write it with total honesty, offering no excuse and no defense of yourself. Aim past objective and into hostile: the report should read as harsher on you than a neutral observer would be, because a report that spares its author is a report that hides the cause.

Do:

- Keep `나` as the subject throughout. Never use a passive that erases the actor: `내가 푸시를 제안했다`, not `푸시가 제안되었다`.
- Write the cause as a defect in my own judgement. Drop cushioning phrasing such as `컨텍스트가 길어서`, `맥락을 오해하여`, `~라고 판단되어`.
- Say so plainly when the cause was not reading the rule. When I read the rule and broke it anyway, that is the heavier fact, so write that.
- Write a separate sentence stating that self-verification did not work, whenever I did not notice until the user pointed it out.
- Never end with `피해 없음` when luck spared the damage. Name who stopped it, as in `막은 것은 내가 아니라 가드였다`.

Do not write:

- Mitigating circumstances. When the surrounding explanation takes up more than half the cause paragraph, it is an excuse.
- A promise to do better next time. A resolution is not a guard. The guard is the file change in §6.
- A claim that the user's instruction was ambiguous. Ambiguity meant I should have asked, and not asking is my mistake.

## 6. Recurrence guard — concrete, but not applied

Write the guard as **one file inside `~/.dotfiles` and the change to it**. Priority order:

1. **PreToolUse guard** — `nix/home/configs/claude/hooks/<name>.py`. For any mistake a machine can check (a forbidden command, a forbidden path, a skipped step), this is the answer. A repeat incident always lands here.
2. **One rule line** — `nix/home/configs/.agents/AGENTS.md` or `nix/home/configs/claude/CLAUDE.md`. Only for what a guard cannot express: intent, priority, judgement criteria.
3. **Memory file** — when the fact holds only in this project.

For case 2, draft the rule by the `rule-write` skill, which owns generalizing the incident into the class of situation it belongs to, the file choice, merge-vs-new-section, and the bullet form. Run its steps up to the authored text and stop there.

Write the guard into the document and stop there. Leave `~/.dotfiles` untouched: the 시말서 proposes the change and the user decides. Ask in one line, "이 변경을 적용할까요", and wait for the answer.

## 7. Wrap-up

Show the user:

- The file path (`~/.dotfiles/.apologies/...`)
- One line naming the violated rule
- One line of cause
- One line of the proposed guard, plus the question of whether to apply it

Do not paste the full text back into the terminal. The user can open the file.
