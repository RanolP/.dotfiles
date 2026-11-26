---
name: ketchup
description: Catch the user up on what changed since the last message they typed -- worker results, PRs, CI, running jobs -- in plain words and small pictures, re-checking live state, then list every call only the user can make with the pick, evidence and risk for each. Read-only. Use for /ketchup.
disable-model-invocation: true
---

# ketchup

Catch the user up on what changed since the last message they typed before `/ketchup`, then lay out every call waiting on them so they can make each one from the reply alone. Their messages are the window's edges: task notifications, worker results, hook output and late REPL output arrived after it and are part of the catch-up. Assume the user remembers that last message and nothing after it.

This is the reply shape for the `(clock)` case in `CLAUDE.md`: a long stretch of background work the user did not watch.

## 1. Gather -- read-only

Keep the turn read-only: no edit, commit, job start, post or worker spawn. Pictures come only from what the work already produced.

- Collect your own work since that message, every worker's completion (its ID, task and verdict), and messages from anyone else in the chat.
- Re-query the live state of every PR, CI run, branch and worker the window touched, per the `(state)` rule in `AGENTS.md`: `gh pr view <n> --json state,isDraft,mergeable,mergeStateStatus`, `gh pr checks <n>`, `git fetch` then `git log origin/<base>`, and `running()` or the task list for workers. A notification is a past reading; the query is the state.
- Check each number you will show against its source, and say so when you correct one.
- Collect the action items. An action item is a call or step only the user can take: a product choice, an approval, an irreversible or outside-visible action, an input only they hold, access you lack. Carry over every one still waiting, including one raised before their last message (a pending rebuild, an approval request, a merge). Work you can still do yourself goes in the "left for me" line instead. An unrequested step the work does not need becomes an item only when it is irreversible and waiting on the user, and then it gets one line.
- For each item, collect its link, what it changes for users, the evidence behind your pick, its risk, and your pick. Write `unknown` for a fact the call needs that you do not have; leave out a link you do not have.

## 2. Write the reply

Spend the words on the calls. The story of what happened stays under 100 words, not counting pictures, and shorter when less happened; each item gets about 30 words, so the reply grows with the item count. Keep every item at full size whatever the total comes to: each one appears as its own entry rather than as a count or a bare link.

1. **Open** with one sentence naming what waits on the user, or saying nothing does. When nothing happened and nothing waits, say that and stop.
2. **Pictures**, inline: the screenshots and videos the work produced, then any diagram that explains a change.
3. **One bullet per thing the user asked for**, written the way you would say it aloud ("Search was slow from a missing index"), ending in exactly one of `done`, `still running`, `failed`, `not checked`. Something waiting on the user is not `done`. Name any bug found and fixed on the way. Each line stays true read alone.
4. **At most three lines** that change what the user knows or must do, then **one line** naming the work left that you can do yourself.
5. **Action items**, numbered `K1`..`Kn` so "do K2" is unambiguous. Ask the call the user owns (merge, approve, pick, run the rebuild) and give your pick; a step that must come first or cannot be undone goes inside the pick.
   - One item: one bullet with the call, pick, what it changes for users, evidence, and risk.
   - Items sharing a call (a set of PRs awaiting merge): the call and pick once, then one bullet per item, riskiest first, each with its link, what it changes, evidence and risk; name an item's pick only where it differs.
   - A call between options: every option weighed, each with what it gets the user, what it costs, and the current state when there is one; those costs are the risk.
   - Give each risk even when low ("Low risk: only the colors change"). Say what waiting costs only when it is more than delay -- a deadline, lost data.

**Voice.** Say what changed for the user, not how: "the tests pass", not "CI is green". The story and the per-request bullets leave out hashes, paths, commands, build numbers and test counts unless the user needs one to act. Each action item carries the exact identifier the user acts on, paired with its meaning-name per `AGENTS.md` "Text another person reads": `PR #128 (Fix token refresh race)`, worker `a1b2c3` (the auth audit). Call everything else by a name the user already knows from before this window.

## 3. Pictures

A picture is a screenshot, a video, a Mermaid diagram, a chart, or a `visual-explainer` render. A Markdown table is text, so a status list or the action items stay prose and bullets.

- Draw when a picture is easier to grasp than sentences: how a design or system works, a PR stack with each PR's state, a fix's before and after, options side by side. Each picture connects its parts; a fact appears once across text and pictures.
- Keep each one readable at a glance: at most six boxes, at most eight words per box, labelled in plain spoken words. A fact that needs a sentence goes in the text.
- Embed screenshots and videos inline when the change is visible. A visible change with no capture gets "No screenshot yet" on its summary line, plus what changed on screen in words. Draw only screens you captured and numbers you have, and link only artifacts that exist.
