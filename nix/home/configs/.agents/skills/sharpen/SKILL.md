---
name: sharpen
description: Make a task deeper rather than bigger -- answer what a top professional would do, start from, use and check against, then rewrite the user's draft prompt to ask for exactly that. Use for /sharpen.
disable-model-invocation: true
---

# sharpen

The user hands over a draft task or prompt and wants a deeper version of it, not a larger one. Answer four questions first, one line each:

1. **The professional's move** -- what a top practitioner in this field would do here that the draft does not ask for.
2. **The raw material** -- the most primary source they would start from (the data, the spec, the source code, the log) in place of a summary someone already digested.
3. **The method** -- the specific methods and tools they would use, by name.
4. **The outside check** -- what, other than the agent or the user, would show the result is right: a test, a measurement, a reference implementation, a standard.

Then return the rewritten prompt in one fenced block, in the draft's own language. In it, mark each choice an experiment can settle as a `prototype` step (skill `prototype`) that recommends an option from what the run showed, and leave each product or preference choice no experiment can settle as a question for the user.
