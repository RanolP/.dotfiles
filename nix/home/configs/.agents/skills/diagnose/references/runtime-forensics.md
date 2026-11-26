# Runtime forensics

Use this when the process is still running and the symptom is a spin, a leak, a hang or a visual glitch. The deliverable is a cited diagnosis: the captured signal, the reduced finding, how the mechanism was proven, and the source location. Hand back to Phase 5 once the cause is known.

## 1. Capture a real artifact on the matching surface

| Symptom | Capture |
|---|---|
| Node process spinning | `node --cpu-prof --cpu-prof-dir=<dir> <script>` writes a `.cpuprofile` at exit |
| Node memory growing | `node --heapsnapshot-signal=SIGUSR2 <script>`, then `kill -USR2 <pid>` once early and once after growth; or `require('v8').writeHeapSnapshot(path)` at two points |
| Web page slow or janky | `agent-browser trace start` ... `agent-browser trace stop <path>`, or `agent-browser profiler start` ... `profiler stop <path>` for a CPU profile |
| React re-rendering | `agent-browser react renders stop --json` |
| App on a device or simulator | `agent-device help commands` lists its `perf`, `trace` and `logs` commands; read it before the first call |
| macOS process hung or spinning | `sample <pid> 5 -file <path>` (no sudo); `spindump` needs sudo, so it goes to the user as a `! sudo spindump <pid> ...` line |

Capture inside the same batch that triggers the symptom (the `ui-automation` skill), so a transient state is still present when the capture starts. Keep artifacts in the scratchpad and name each path in the report.

## 2. Reduce it to the smoking gun

Name the one thing the artifact shows: the function holding self-time on the hot path, the retainer chain from the leaked object to a GC root, the timer or listener firing with no input. A large artifact goes to a worker that queries it with `references/trace-forensics.md` and returns only the reduced finding, so the raw dump stays out of the main context.

## 3. Prove the mechanism in place

Confirm the hypothesis on the running process before editing source: `agent-browser eval <js>` to read the suspect state or monkey-patch the suspect function and watch the symptom stop, a Metro fast refresh with one targeted change, or a Node inspector session (`node --inspect`) evaluating in the live context. One injected change per probe, matching Phase 4.

## 4. Map it to source

Report the finding as `file:symbol:line` -- the line that allocates, schedules or loops. When the artifact's frames carry no source mapping, follow step 4 of `references/trace-forensics.md`.
