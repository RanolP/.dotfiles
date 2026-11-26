---
name: teach
description: Explain a change, subsystem or concept plainly so the user actually understands it -- runs skills `how` and `why` in parallel and weaves what they find into one plain account, smallest complete answer first, deeper on request. Use for /teach and "help me really understand X". For quizzing and drilling to mastery, use `socratic-tutor`.
disable-model-invocation: true
---

# teach

Explain what the thing is, how it works and why it is built that way, in one plain account at the user's pace. The goal is their understanding; nothing gets changed.

1. **Pick the takeaways.** Decide the few things the user should walk away with, from why they are asking (about to change it, reviewing it, debugging it, new to it) and what they already know, both read from the conversation. Put the depth where their question is.
2. **Let `how` and `why` dig.** Read enough code to get oriented, then run skill `how` for the mechanism and skill `why` for the record, in parallel, and combine what they return; a small change may need only one. Carry `why`'s inference labels and open questions through unchanged, because they are findings about the record.
3. **Definition first.** Name the thing and say what it is in general terms, with its common name where it has one, then tie it to this case and build outward: the problem each part solves and how it actually works, walking through what happens as the user does the thing when that makes it land.
4. **Smallest complete answer, then stop.** A sentence or two that stands on its own, then an offer to go deeper or move on, and follow their lead. State each point directly, in the user's language and in plain sentences, giving each concept one name and keeping it.
5. **Show it.** Open the diff or the code when that lands faster. For a flow with three or more moving parts, draw a short series where each diagram redraws the last and adds one part, through skill `visual-explainer`.

**Reply:** the explanation itself, main point first, then the threads worth chasing with `how` or `why`.
