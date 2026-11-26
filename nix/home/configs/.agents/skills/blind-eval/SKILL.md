---
name: blind-eval
description: Compare two variants of a skill, rule, prompt or agent definition by running candidates that cannot tell they are being measured -- sanitized project-shaped directories, an organic user prompt, a judge-only rubric, one other-vendor judge scoring every output under neutral labels in one pass, adherence graded from transcripts and code shape rather than self-report, and main reading every output.
when_to_use: When the user wants to know whether a rule, skill, prompt or agent-definition change actually changes behavior ("does this rule work", "A/B this skill", "blind test these variants"), or before promoting a variant written with skill `rule-write`, `dotfiles:evolve` or `prompt-authoring`. Picking the best of several attempts at one artifact is skill `arena`.
---

# Blind eval

You own the experiment design. A candidate that can see it is being measured behaves like a candidate being measured, so every surface a candidate reads looks like ordinary work. Skill `arena` carries the judge mechanics this skill reuses; this skill adds the blinding.

## Blinding the candidate sees

- Every directory, file name, slug and prompt a candidate sees uses project-shaped names a user might pick (`invoice-export`, `settings-page`). Before spawning, run this over each candidate directory and the prompt file, and expect no output:

  ```sh
  rg -il 'eval|test|judge|experiment|rubric|score|compare|benchmark|candidate|arena|variant' <candidate-dir> <prompt-file>
  ```

  A hit in code the task genuinely needs (a `tests/` folder in the project skeleton) stays only when a real project of that shape would have it.
- The prompt is what a user would type for this task: the goal, never the thing measured. Ask for design notes in general when you need the reasoning; leave out any request to list the skills, rules or files applied, because a self-report grades the report, not the behavior.
- Each candidate works alone. Its brief never mentions other candidates, other variants or a comparison.

## Steps

1. **Frame.** Name the variant under test (the exact file and the change), the behavior that counts as success, and 3-6 concrete criteria. Write the criteria to a judge-only file outside every candidate directory (`<scratchpad>/blind-<slug>/judge/rubric.md`).
2. **Set up the environments.** One directory per candidate under `<scratchpad>/blind-<slug>/`, each a sanitized copy of a realistic project skeleton with the variant in place where a real session would load it (the skill directory, the rules file, the agent definition). Plant what an organic task would have: the files, the history, the skills the candidate would naturally read. Run the `rg` check above.
3. **Author one organic prompt** and give the identical text to every candidate.
4. **Spawn the candidates** in one message, in the background, per skill `arena` phase 2: at least two per variant so one lucky run does not decide it, each in its own directory.
5. **Judge once.** Shuffle every output from both variants under labels `A1..An`, keep the label map in main's context only, and spawn one read-only judge from a vendor other than the candidates' (`hetero-subagents:codex:gpt-6.2-astra` when the candidates are Claude, or `hetero-subagents:agy:gemini-4-neon-high` for large outputs), per skill `arena` phase 3. That single call gets the rubric and all labelled outputs and scores them on one scale. The judge may know it is judging; it never sees a model name or which variant produced a label.
6. **Grade adherence from transcripts.** For each Claude candidate, read its subagent transcript (`<config>/projects/<slug>/<session-id>/subagents/*.jsonl`, where `<config>` is `$CLAUDE_CONFIG_DIR` or `~/.claude`) and list which files it actually opened and which tools it ran; for a codex or agy candidate, read the tool calls its reply relays. Grade whether the variant was followed from those reads plus the shape of the output. Read only this session's own transcripts.
7. **Read every output yourself** end to end and score it against the rubric before opening the judge's verdict. Record agreement per label. Where you and the judge disagree, either one of you is biased or a criterion is ambiguous: read both reasons, sharpen the criterion, and say which it was.

## Reply

The variant under test; the rubric; per-label notes with the variant revealed after scoring; the judge's verdict and where you disagreed; the adherence evidence from step 6; and whether to promote the variant, with the measured difference that supports it. A difference within the spread between runs of the same variant is no measurable difference.

---

*Adapted from pstack 0.15.48 (MIT, Lauren Tan): `skills/poteto-mode/playbooks/eval.md`.*
