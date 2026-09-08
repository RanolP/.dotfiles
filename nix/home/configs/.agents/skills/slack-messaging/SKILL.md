---
name: slack-messaging
description: Send Slack messages through the claude.ai Slack MCP the safe way — draft first, resolve the channel or user id before writing, read the thread before replying, and schedule instead of sending when the time matters. Use whenever the user asks to message, DM, ping, reply to, announce to, follow up with, or schedule anything in Slack, and before any `mcp__claude_ai_Slack__slack_send_message` call, even when the user sounds like they just want it sent.
---

# Slack messaging

Every fact below is read off the `mcp__claude_ai_Slack__*` tool schemas. The tool prefix is dropped from here on; `slack_send_message` means `mcp__claude_ai_Slack__slack_send_message`.

## A sent message is permanent

This bundle has no update-message and no delete-message tool. Once `slack_send_message` returns, the message stands in someone else's client and nothing you can call takes it back. `slack_send_message`'s own schema says it: *"If user has not reviewed the message, use slack_send_message_draft instead."*

So the default path is `slack_send_message_draft`. It writes the text into the user's **Drafts & Sent** in Slack and sends nothing; it returns a `channel_link` the user opens to read, edit, and send it themselves. That turns an irreversible action into a reviewable one at the cost of one click.

Call `slack_send_message` only when the user has seen the exact text and said to send it. "Tell Jane the build is green" is a request to compose, not a grant to send.

Before either tool, the draft goes in your reply as text the user can read without leaving the terminal. This user has asked for that explicitly and repeatedly -- "요약해서 짧게 슬랙 메시지 초안 적어봐. 나한테 보여달라는 거다" -- and asked for it again even when the target thread and the source content were both already settled. A `channel_link` they have to click is not the same as seeing the words.

One wrinkle worth knowing: only **one attached draft per channel** exists, so a second draft into the same channel fails with `draft_already_exists` — ask the user to send or discard the pending one rather than working around it. Its other errors name their own fix: `channel_not_found` (wrong id or no access) and `not_in_channel` (the user must join first). When you do send a message that a draft already holds, pass that draft's `draft_id` to `slack_send_message` so the draft is cleaned up instead of lingering as a duplicate.

## Resolve the target before writing a word

`channel_id` is an id, never a name. Guessing one is how a message lands in the wrong room, so resolve it first:

- **A channel by name or topic** — `slack_search_channels(query, channel_types="public_channel,private_channel")`. Channel names are typically lowercase-with-hyphens; it returns at most 20 results.
- **A channel the user is already in** — `slack_list_user_channels(types="public_channel,private_channel,im,mpim", name_prefix="eng-")`. DMs (`im`) and group DMs (`mpim`) are excluded unless you list them explicitly. On a multi-workspace Grid org, memberships are per-workspace: pass `team_id` or you only see the default workspace.
- **A person** — `slack_search_users(query)` takes full names, partial names, emails, or profile terms like `engineering -intern`. **Its user id doubles as the `channel_id` for a DM** — there is no separate open-DM step. For a note-to-self, resolve the connected account's own id the same way rather than hardcoding one, because that id is account-specific.

When two candidates match and the wrong one is embarrassing, ask. The user knows which `#deploys` they meant.

## Reply in the thread, and read it first

A reply is `thread_ts` set to the **parent message's** timestamp (`"1234567890.123456"`, always a string with the decimal point). Omitting it posts a fresh top-level message to the channel, which reads as an interruption to everyone watching the thread.

Read before you write: `slack_read_thread(channel_id, message_ts=<parent ts>)` returns the parent plus every reply, so the answer fits what was actually asked instead of restating something three messages up. To find the parent in the first place, `slack_read_channel(channel_id)` returns newest-first, and `slack_search_public` with `is:thread` finds threads by content.

Reading the thread is also how you learn the shape to write in. Reuse the layout of the messages already in that channel or thread instead of inventing one -- "예전 거랑 비교해서 잘 포매팅해봐라", "이전 스레드와 비슷한 포맷으로 내줘".

`reply_broadcast=true` also copies the reply to the channel — available on `slack_send_message` and `slack_schedule_message`, not on the draft tool. It notifies the whole channel, so reserve it for a resolution the channel is waiting on.

## Formatting: standard Markdown, with limits

Contrary to Slack's classic `mrkdwn`, `slack_send_message`'s schema states the `message` field takes **standard markdown** — `**bold**`, `_italic_`, `` `code` ``, `~~strikethrough~~`, `>` blockquotes, lists, links, code blocks, tables, and headers. The draft and schedule tools also describe their `message` as standard markdown, though only `slack_send_message` spells out tables and headers. Take that at face value rather than hand-converting to `*bold*`.

Three constraints the schema spells out:

- **5000 characters** per text element.
- **Tables** use ordinary `|` pipes; do not escape the structural pipes, and escape `\|` only for a literal pipe inside a cell.
- **Code blocks** accept a language tag (` ```python `) for highlighting and a copy button.

Two more things it warns about: keep sensitive values out of link query params, and **no tool here can post to externally shared (Slack Connect) channels** — a Connect channel needs the user to post by hand.

Link previews are off by default; set `unfurl_app_links=true` on `slack_send_message` when the message carries GitHub, Jira, or Figma links worth expanding.

## Short lines, never paragraphs

The recurring correction on this user's drafts is length and shape, not accuracy. "문장이 너무 길고 리스트가 아니야. 슬랙 메시지 다시 정리해" came first; "여전히 기니까 더 구조화하고 문장 다듬어" came after the revision. Treat your first draft's length as a ceiling to beat.

- One idea per line, as a list, with the point at the front of the line.
- Cut every sentence that repeats a fact another line already carries.
- Keep prose only for a single argument a list would break.

## Boundaries this user has set

- **The designer is off limits.** "디자이너와 소통은 니가 슬랙 맨날 사고 치니까 절대 안맡김" -- do not draft or send anything to the designer; hand that conversation back to the user.
- **Weigh the blast radius before any write.** A send either delivers information or interrupts the team, and the second one is a cost the recipients pay. When it is closer to an interruption, say so and do not send.
- **Do not reconfigure the Slack MCP.** Use it to read, to draft, and to send what was approved; leave its setup alone.
- **Synthesize, then ask for verification.** When the answer lives across a Slack thread and a Jira card, combine them yourself and bring the finished result for the user to check, rather than asking them to supply the pieces.
- **A Slack post never triggers a ticket transition on its own.** After posting, ask which cards to move instead of inferring them from the message.

## Scheduling

`slack_schedule_message(channel_id, message, post_at)` queues a message for later; it never sends now. `post_at` is a **Unix timestamp in seconds**, at least 2 minutes in the future and at most 120 days out — compute it from the recipient's timezone, not yours, and verify the number before passing it, because a scheduled message **cannot be edited through the API**. The only fix for a wrong one is the user deleting it from "Drafts & sent" in the Slack UI.

It takes `thread_ts` and `reply_broadcast` like the send tool, and it is blocked on Slack Connect channels too.

Scheduling is not a substitute for review. When the user has not read the text, draft it; when they have read it and want it to land at 9am, schedule it.

## Worked example

> "Ask Jina in #deploys whether the canary is safe to promote."

```
slack_search_users(query="Jina")                     # → U04XXXX, confirms who
slack_search_channels(query="deploys")               # → C07YYYY, the real id
slack_read_channel(channel_id="C07YYYY", limit=20)   # → finds the canary thread's parent ts
slack_read_thread(channel_id="C07YYYY",
                  message_ts="1751030400.123456")    # → what the thread already says
slack_send_message_draft(
  channel_id="C07YYYY",
  thread_ts="1751030400.123456",                     # the canary thread's parent ts
  message="Jina — canary's been green for 40m. Safe to promote?",
)
```

Then hand the user the returned `channel_link` and say the draft is waiting, unsent. Escalate to `slack_send_message` only on their explicit go.
