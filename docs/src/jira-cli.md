# jira-cli

Fine-grained editing of a Jira card's body. Select a node inside the card's Atlassian Document Format (ADF) tree with a CSS selector, stage the edit, then flush a batch of edits as a single write.

**Managed by:** `nix/home/programs/jira-cli.nix` — a `writeShellScriptBin` wrapper that runs `nix/home/configs/jira-cli/jira.py` through `uv run --script`. `uv` comes from mise, not from nixpkgs, so the wrapper resolves it off the caller's `PATH` and fails with a named instruction when it is missing.

The script is a single PEP 723 file. Its dependencies (`lxml`, `cssselect`, `jsonschema`) are declared in the script header and resolved by `uv` at run time, so nothing is compiled during a rebuild.

## Why it exists

The web editor is the only practical way to change one table cell, one heading, or one list item, and it makes those surgical changes slow and error-prone. This CLI turns them into one command.

Two constraints shaped the design: no OAuth app registration, and no credential to manage or rotate. Both hold. Auth is Dynamic Client Registration plus PKCE against the Atlassian MCP endpoint, so the first run registers its own public client and the refresh token renews access silently from then on.

## Layers

| Layer | What it does |
|---|---|
| Auth | DCR on first login, PKCE authorization code, refresh on 401 or near expiry. `~/.config/jira-cli/credentials.json`, mode 0600. |
| Transport | MCP JSON-RPC over HTTPS with `urllib`, session id, SSE-or-JSON unwrapping. |
| Selector | Projects the ADF onto an `lxml` tree — one element per node, tag = the node's `type`, `attrs` as XML attributes, and a `ptr` attribute holding the RFC 6901 pointer. `cssselect` translates the selector to XPath. |
| Queue | `~/.config/jira-cli/queue.json`. Each entry holds the issue key, the selector, the operation, the new content, the resolved pointers, and a deep snapshot of every matched node. |
| Apply | Dry-runs every queued card, then writes. `editJiraIssue` with `contentFormat: "adf"`, one call per card. |

## Commands

```
jira login [--force]                                   # authorize this machine
jira edit queue -i KEY 'selector' < new.json           # replace the matched node
jira edit queue -i KEY 'selector' --before  < new.json
jira edit queue -i KEY 'selector' --after   < new.json
jira edit queue -i KEY 'selector' --append  < new.json
jira edit queue -i KEY 'selector' --delete
jira edit queue -i KEY 'selector' --text '새 제목'
jira edit queue -i KEY 'selector' --all                # allow a multi-node match
jira edit queue -i KEY --jq 'select(.type=="media")'   # escape hatch
jira edit status
jira edit drop N | --all
jira edit apply [--token=7f3a9c2e]
jira show  -i KEY [--pointer /content/3]               # default: the selector's XML view
jira show  -i KEY --json                               # raw ADF, the shape stdin wants
jira show  -i KEY --rendered                           # lossy plain text, cheapest to read
jira search 'project = PROJ AND status != Done'        # JQL, one row per card
jira info  -i KEY                                      # status, assignee, parent, labels
jira types [NAME]                                      # ADF vocabulary, from the schema
jira media ls -i KEY
jira schema update
jira selfcheck
```

`jira --help` carries the whole mental model — the staging workflow, a selector cheat sheet, what reads stdin, and the safety rules — so an agent can drive the tool cold without a skill. `jira edit queue --help` and `jira edit apply --help` add the per-command detail.

## Three views of a body

`jira show` prints the same card three ways, and the default is the XML projection the selector layer already builds. Measured on `nix/home/configs/jira-cli/fixture.adf.json`:

| View | Size | What it is for |
|---|---|---|
| `--xml` (default) | 2527 chars, 39% smaller than the JSON | The selector surface: tag = node `type`, `attrs` as attributes, `mark` space-separated, `ptr` the JSON pointer. Read this to write a selector. |
| `--json` | 4101 chars | Raw ADF. The only write format — copy a node here, edit it, feed it to `jira edit queue`. |
| `--rendered` | 134 chars | Markdown-ish plain text. The cheapest read, and never a write path. |

The default changed to `--xml` because reading is the common case and the JSON view spends most of its bytes on punctuation. `--xml` is accepted explicitly so a script can state the view it wants.

`--rendered` walks the ADF rather than the lxml projection, so a link keeps its `href` and a `media` node keeps its id, where `--xml` shows only the bare mark name. It still drops every pointer, so nothing read this way can be edited and pushed back.

One consequence of making the projection a printed format: an attribute now renders as ADF's own literal instead of Python's `repr`. A boolean reads `false`, never `False`, which also means `table[isNumberColumnEnabled="false"]` matches — the selfcheck asserts exactly that.

## Reading a card's fields

`jira search 'JQL'` and `jira info -i KEY` cover what the body-editing commands cannot see. Both are read-only.

`search` prints one row per card with the four fields that place it — status, assignee, parent, summary — because a wider default makes every row wrap. `--fields status,priority,labels` widens it, `-n` sets the page size (1-100, the MCP search caps a page at 100), and `--json` prints the raw response. A Jira timestamp is trimmed to the minute in both commands, since the milliseconds and the offset widen every row and no one reads them.

`jira types` answers the one question the help text cannot hold: the ADF vocabulary. With no argument it prints the 43 node types and the 17 mark types apart from each other, because a mark is never an element name and reaches a selector only through `text[mark~="…"]`. With a name it prints that type's required fields and its `attrs` schema. Both are derived from the schema file, so neither goes stale when `jira schema update` runs.

Each `queue` flag maps to exactly one RFC 6902 operation: replace, `add` at index, `add` at index+1, `add` at `/-`, `remove`. `move` and `copy` are excluded on purpose, because both mutate two locations and that breaks the one-selector-one-snapshot guard.

`jira media ls` exists because the MCP surface has no attachment tool, so file upload is impossible here. Upload through the web UI, then this command lists the `media` nodes already on the card with their ids so the CLI can position and reference them. External images work through a `media` node with `type: "external"` and a `url`.

## Safety rules

**A multi-match aborts.** A selector matching two nodes is an error unless `--all` is passed. Taking the first match silently edits the wrong paragraph.

**Pre-flight, then write.** `apply` re-fetches every queued card and dry-runs the whole batch before writing anything. Jira has no transaction, so a half-applied batch cannot be rolled back, and a clean zero-write abort is the only safe failure.

**Drift needs a content-hash token.** When a re-resolved node no longer deep-equals its snapshot, `apply` prints both values and refuses:

```
$ jira edit apply
✗ TICKET-7758  /content/3  큐에 담을 때와 내용이 다릅니다

    큐 스냅샷 : "설계 포인트 — 상태 모델"
    현재 카드 : "설계 포인트 — 상태 모델 (v2)"

  그래도 밀어붙이려면:
      jira edit apply --token=7f3a9c2e
```

The token is the first 8 hex of a SHA-256 over the drifted state, not a random string. A random token would need storage, expiry, and single-use bookkeeping, and it would still admit the worst case: a token issued at 10:00 and pasted at 10:30 silently authorizing a third change that arrived in between. A content hash cannot do that, because a further change yields a different hash and the stale token stops matching. One token covers the whole `apply`.

**Selectors re-resolve at apply time.** Within one batch a `--delete` shifts every later sibling's index, so a frozen pointer would patch the wrong node with no error. The pointer stored in the queue is diagnostic only, which is what lets `jira edit status` print without a network call.

**Local schema validation before every write.** The vendored draft-04 ADF schema validates the finished document. The whole-document schema is one giant `anyOf`, so its top-level error blames the innocent parent and dumps the parent's entire JSON. Validation instead walks bottom-up and checks each node against only the definitions that declare that node's own `type`, so the report names the node that is actually wrong:

```
✗ PLAYGROUND-157 would become invalid ADF, nothing written:
    /content/0: Additional properties are not allowed ('content' was unexpected)
```

## Schema

`nix/home/configs/jira-cli/adf-schema-56.7.3.json` is vendored verbatim from npm `@atlaskit/adf-schema@56.7.3` (`dist/json-schema/v1/full.json`), Apache-2.0, Atlassian Pty Ltd. `jira schema update` downloads the current upstream schema to `~/.config/jira-cli/adf-schema.json`, which takes precedence over the vendored copy when it exists. Delete that file to fall back to the pinned version.

## Known limits

Markdown is a lossy view of a card and is never used as a write path — reading a card as markdown degrades an attached image to a `blob:` URL on a staging host. The MCP access token returns 401 against `api.atlassian.com/.../rest/api/3/*`, so there is no REST fallback for anything the MCP surface omits. File upload, bulk edit across cards from one selector, sprint and board operations, and Confluence are all out of scope. `--rendered` is a read path only: it has no pointers, so no edit can be expressed against it.
