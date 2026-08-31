---
description: Wait for a Metro dev server and its bundle by asking Metro directly, instead of polling its log file with sleep.
when_to_use: Any React Native task that starts Metro and then needs the server up, the bundle built, or the app reloaded -- a device screenshot, an e2e run, a QA pass, a reload after an edit. Also when you are about to write `until grep ... metro.log; do sleep N; done`.
---

Metro answers two questions over HTTP. Ask it, and the wait ends the moment the answer is true.

Log polling guesses at those answers from the outside. A measured 7 days of transcripts spent **2,459 seconds** inside `until grep ... do sleep ... done` loops over `metro*.log`, and the three worst single calls were 421.7s, 300.3s and 180.3s -- each one a loop watching for a substring that Metro had already committed to an endpoint.

## Is the server up

`GET /status` returns the body `packager-status:running`. It is served by `@react-native-community/cli-server-api/build/statusPageMiddleware.js`, **not** by Metro itself -- `packager-status` does not appear anywhere in `metro/src`, so a version running bare Metro without the community CLI has no `/status`.

```bash
until curl -sf -m 2 http://localhost:8081/status | grep -q packager-status:running; do sleep 1; done
```

This is the one place a `sleep` is legitimate: nothing exists to connect to yet, so there is no condition to block on. Keep the interval at 1s and the per-request timeout at 2s.

Two helpers already ship in `node_modules` and encode the same check, including the "something else is on this port" case:

- `@react-native/community-cli-plugin/dist/utils/isDevServerRunning.js`
- `@react-native-community/cli-tools/build/isPackagerRunning.js`

## Is the bundle built

**Request the bundle.** `metro/src/Server.js:516` routes any path ending in `.bundle` through `await this._processBundleRequest(...)`, so the HTTP response does not arrive until the build finishes. The request *is* the condition wait -- no loop, no interval, no guessed duration.

```bash
curl -s -o /dev/null -w 'http=%{http_code} bytes=%{size_download} in %{time_total}s\n' \
  --max-time 600 \
  'http://localhost:8081/index.bundle?platform=android&dev=true&minify=false'
```

Swap `platform=ios` for iOS, and the entry name if the project's entry file is not `index`.

Read the result rather than assuming it:

- `http=200` with a large `size_download` -- built.
- `http=500` -- a build error. The body carries it, so drop `-o /dev/null` and read it instead of re-running the request.
- `curl` exit 28 -- the `--max-time` ceiling was hit. That is a hung or crashed bundler, not a slow one; look at the log, do not retry.

Warming the bundle this way before the app connects also removes the first-launch stall that a fixed `sleep` was covering for.

## Reload after an edit

Metro's file watcher rebuilds on its own. After an edit, re-request the bundle -- the same blocking call returns when the new build is ready, which is the reload gate.

## What not to write

`sleep 150`, `sleep 340`, or `until grep -q "bundle" metro.log; do sleep 5; done`. A fixed duration overshoots whenever the build finished early and forces a second call whenever it did not; a log grep matches on a substring whose wording belongs to Metro's console output rather than to its contract.

Start Metro with its log redirected anyway -- the log is where a **failure** is diagnosed. It is just not where readiness is detected.

## Verified against

A React Native app's `node_modules` on 2026-08-28: `metro/src/Server.js:516-518` (the awaited `.bundle` branch) and `@react-native-community/cli-server-api/build/statusPageMiddleware.js` (the `packager-status` body). Re-check both after a React Native upgrade -- `/status` in particular moved out of Metro and could move again.
