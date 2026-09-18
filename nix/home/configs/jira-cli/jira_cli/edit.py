"""The staged-edit domain: the queue file and the `edit queue/status/drop/apply` commands."""

import copy
import hashlib
import json
import os
import sys

from jira_cli.adf import (
    _shown,
    _sortkey,
    _summary,
    apply_op,
    resolve,
    select,
    select_jq,
    validate,
)
from jira_cli.auth import CONFIG_DIR, Fail

QUEUE_PATH = os.path.join(CONFIG_DIR, "queue.json")


# ----------------------------------------------------------------------- queue


def _read_queue():
    if not os.path.exists(QUEUE_PATH):
        return []
    with open(QUEUE_PATH) as f:
        return json.load(f)


def _write_queue(q):
    os.makedirs(CONFIG_DIR, mode=0o700, exist_ok=True)
    with open(QUEUE_PATH, "w") as f:
        json.dump(q, f, indent=2, ensure_ascii=False)


def _resolve_pointers(doc, sel, jq, allow_many):
    ptrs = select_jq(doc, jq) if jq else select(doc, sel)
    if not ptrs:
        raise Fail(f"selector matched nothing: {jq or sel}")
    if len(ptrs) > 1 and not allow_many:
        listing = "\n".join(f"    {p}  {_summary(resolve(doc, p)[2])}" for p in ptrs[:8])
        raise Fail(
            f"selector matched {len(ptrs)} nodes — pass --all to edit them all:\n{listing}"
        )
    return ptrs


# -------------------------------------------------------------------- commands


def cmd_queue(mcp, a):
    payload = None
    if a.text is not None:
        op = "text"
        payload = a.text
    elif a.delete:
        op = "delete"
    else:
        op = next((o for o in ("before", "after", "append") if getattr(a, o)), "replace")
        raw = sys.stdin.read()
        if not raw.strip():
            raise Fail(f"--{op} reads the new ADF node from stdin, and stdin was empty")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as e:
            raise Fail(f"stdin is not valid JSON: {e}")

    doc = mcp.get_doc(a.issue)
    ptrs = _resolve_pointers(doc, a.selector, a.jq, a.all)
    entry = {
        "key": a.issue,
        "selector": a.jq or a.selector,
        "mode": "jq" if a.jq else "css",
        "op": op,
        "content": payload,
        "all": bool(a.all),
        "pointers": ptrs,
        "snapshots": [copy.deepcopy(resolve(doc, p)[2]) for p in ptrs],
    }
    q = _read_queue()
    q.append(entry)
    _write_queue(q)
    print(f"✓ 큐에 담았습니다  #{len(q)}  {a.issue}  {op}")
    for p in ptrs:
        print(f"    {p}  {_summary(resolve(doc, p)[2])}")


def cmd_status(mcp, a):
    q = _read_queue()
    if not q:
        print("큐가 비어 있습니다.")
        return
    for i, e in enumerate(q, 1):
        print(f"#{i}  {e['key']}  {e['op']}  {e['selector']}")
        for p, s in zip(e["pointers"], e["snapshots"]):
            print(f"      {p}  {_summary(s)}")
    print(f"\n{len(q)}건 대기 중 — `jira edit apply`로 반영합니다.")


def cmd_drop(mcp, a):
    q = _read_queue()
    if a.all:
        _write_queue([])
        print(f"{len(q)}건을 버렸습니다.")
        return
    if not 1 <= a.n <= len(q):
        raise Fail(f"#{a.n} 은 큐에 없습니다 (1..{len(q)})")
    gone = q.pop(a.n - 1)
    _write_queue(q)
    print(f"#{a.n} {gone['key']} {gone['op']} {gone['selector']} — 버렸습니다.")


def _plan(mcp, q):
    """Dry-run every queued card. Returns (new_docs, drifts) and writes nothing.

    Selectors re-resolve against the progressively edited document, so a --delete
    that shifts later siblings is seen by the next entry in the same batch.
    """
    docs = {}
    for e in q:
        if e["key"] not in docs:
            docs[e["key"]] = mcp.get_doc(e["key"])

    drifts = []
    for i, e in enumerate(q):
        doc = docs[e["key"]]
        ptrs = _resolve_pointers(doc, e["selector"], e["selector"] if e["mode"] == "jq" else None, e["all"])
        # Deep-copied because a later entry on the same card mutates `doc` in place,
        # and a live reference would let that edit rewrite this entry's drift evidence.
        current = [copy.deepcopy(resolve(doc, p)[2]) for p in ptrs]
        # A changed match COUNT is drift too: reporting only the pairwise diffs would
        # let an entry silently apply to nothing while `apply` still claimed success.
        padded = e["snapshots"] + [None] * max(0, len(ptrs) - len(e["snapshots"]))
        recount = len(ptrs) != len(e["snapshots"])
        bad = [(p, c, s) for p, c, s in zip(ptrs, current, padded) if recount or c != s]
        if bad:
            drifts += [
                {"entry": i, "key": e["key"], "ptr": p, "was": s, "now": c, "ptrs": ptrs, "current": current}
                for p, c, s in bad
            ]
            continue
        for p in sorted(ptrs, key=_sortkey, reverse=True):
            apply_op(doc, p, e["op"], e["content"])
    return docs, drifts


def _drift_token(drifts):
    canon = json.dumps(
        sorted(([d["key"], d["ptr"], d["now"]] for d in drifts), key=lambda x: (x[0], x[1])),
        sort_keys=True, ensure_ascii=False, separators=(",", ":"),
    )
    return hashlib.sha256(canon.encode()).hexdigest()[:8]


def cmd_apply(mcp, a):
    q = _read_queue()
    if not q:
        print("큐가 비어 있습니다.")
        return

    docs, drifts = _plan(mcp, q)

    if drifts:
        token = _drift_token(drifts)
        for d in drifts:
            print(f"✗ {d['key']}  {d['ptr']}  큐에 담을 때와 내용이 다릅니다\n")
            print("    큐 스냅샷 : (없음)" if d["was"] is None else f"    큐 스냅샷 : {_shown(d['was'])}")
            print(f"    현재 카드 : {_shown(d['now'])}\n")
        if a.token != token:
            if a.token:
                print(f"  --token={a.token} 은 현재 상태와 맞지 않습니다 (그 사이 카드가 또 바뀌었습니다).")
            print("  그래도 밀어붙이려면:")
            print(f"      jira edit apply --token={token}")
            raise SystemExit(1)
        print(f"  --token={token} 확인 — 드리프트를 무시하고 진행합니다.\n")
        # Accept what the card actually holds now as each drifted entry's new baseline.
        for d in drifts:
            e = q[d["entry"]]
            e["pointers"], e["snapshots"] = d["ptrs"], d["current"]
        docs, drifts = _plan(mcp, q)
        if drifts:
            raise Fail("card changed again between the check and the write — re-run `jira edit apply`")

    for key, doc in docs.items():
        err = validate(doc)
        if err:
            raise Fail(f"{key} would become invalid ADF, nothing written:\n    {err}")

    for key, doc in docs.items():
        mcp.put_doc(key, doc)
        print(f"✓ {key} 반영 완료")
    _write_queue([])
    print(f"\n{len(q)}건 적용, 큐를 비웠습니다.")


QUEUE_HELP = """\
Stages ONE edit. Nothing is written until `jira edit apply`.

Exactly one operation per invocation:
    (default)   replace the matched node with the ADF node on stdin
    --before    insert the stdin node as the previous sibling
    --after     insert the stdin node as the next sibling
    --append    append the stdin node into the matched node's own content
    --delete    remove the matched node
    --text STR  replace the matched node's text, keeping its type and attrs

The pointer stored in the queue is diagnostic only. Selectors re-resolve at apply
time, so a --delete earlier in the batch correctly shifts later siblings.

EXAMPLES
    jira edit queue -i PROJ-1 'codeBlock[language="python"]' --delete
    jira edit queue -i PROJ-1 'tableRow:nth-child(2) tableCell:nth-child(3) text' \\
      --text '완료'
    echo '{"type":"listItem","content":[{"type":"paragraph","content":[
      {"type":"text","text":"새 항목"}]}]}' \\
      | jira edit queue -i PROJ-1 'bulletList' --append
"""

APPLY_HELP = """\
Re-fetches every queued card, dry-runs the whole batch, and writes only when all
checks pass. Jira has no transaction, so a half-applied batch cannot be rolled
back — a clean zero-write abort is the only safe failure.

Three things abort the run: a selector that now matches nothing or a different
number of nodes, a node whose content changed since queueing, and a document that
would become invalid ADF. The queue is left intact so the run is repeatable.

On drift, the printed --token=<hex> accepts the card's current state as the new
baseline. It is a hash of that state, so a change arriving afterwards produces a
different token and the stale one stops working.
"""


def register(sub, fmt, group_help):
    """`group_help` is the `edit` group's epilog; the top parser shares the same text."""
    ed = sub.add_parser("edit", help="stage and flush ADF edits", epilog=group_help, formatter_class=fmt)
    edit = ed.add_subparsers(dest="sub", required=True)

    q = edit.add_parser("queue", help="stage one edit", epilog=QUEUE_HELP, formatter_class=fmt)
    q.add_argument("-i", "--issue", required=True, metavar="KEY", help="issue key, e.g. PROJ-1234")
    q.add_argument("selector", nargs="?", default=None, help="CSS selector over the ADF tree")
    q.add_argument("--jq", metavar="FILTER", help="escape hatch: a jq filter applied to each node")
    q.add_argument("--all", action="store_true", help="allow a multi-node match")
    for flag, helptext in [
        ("before", "insert the stdin node before the match"),
        ("after", "insert the stdin node after the match"),
        ("append", "append the stdin node into the match's content"),
        ("delete", "remove the matched node"),
    ]:
        q.add_argument(f"--{flag}", action="store_true", help=helptext)
    q.add_argument("--text", metavar="STR", help="replace the matched node's text, keeping type and attrs")
    q.set_defaults(fn=cmd_queue)

    edit.add_parser("status", help="show the queue, without a network call").set_defaults(fn=cmd_status)

    dr = edit.add_parser("drop", help="discard a queued edit")
    dr.add_argument("n", nargs="?", type=int, default=0, help="the #N shown by `edit status`")
    dr.add_argument("--all", action="store_true", help="empty the whole queue")
    dr.set_defaults(fn=cmd_drop)

    ap = edit.add_parser(
        "apply", help="pre-flight every card, then write", epilog=APPLY_HELP, formatter_class=fmt
    )
    ap.add_argument("--token", metavar="HEX", help="content-hash token accepting drift")
    ap.set_defaults(fn=cmd_apply)
