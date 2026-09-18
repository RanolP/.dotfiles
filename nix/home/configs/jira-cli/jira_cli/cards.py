"""Card reads that need no ADF tree: `search`, `info`, and the `comments` thread."""

import json
import sys

from jira_cli.adf import render
from jira_cli.auth import Fail

# Enough to answer "what is this card, who owns it, where does it sit" without
# pulling the description. The MCP default field set is far wider and mostly noise.
CARD_FIELDS = ["summary", "status", "assignee", "reporter", "parent", "issuetype", "priority", "labels", "updated"]
# A search row stays narrow enough to read: the four fields that place a card, and
# nothing that repeats down the whole column. `--fields` widens it on demand.
SEARCH_FIELDS = ["status", "assignee", "parent", "summary"]


def _fv(value):
    """Flatten one Jira field to a single display string."""
    if value is None or value == []:
        return "-"
    if isinstance(value, dict):
        for k in ("displayName", "name", "key", "value"):
            if value.get(k):
                return str(value[k])
        return json.dumps(value, ensure_ascii=False)[:60]
    if isinstance(value, list):
        return ",".join(_fv(v) for v in value)
    text = str(value)
    # A Jira timestamp is ISO with milliseconds and an offset; minutes is what a
    # human reads off a listing, and the extra 14 characters widen every row.
    if len(text) > 16 and text[4] == "-" and text[10] == "T":
        return text[:16].replace("T", " ")
    return text


def cmd_search(mcp, a):
    fields = a.fields.split(",") if a.fields else SEARCH_FIELDS
    res = mcp.call(
        "searchJiraIssuesUsingJql",
        {"jql": a.jql, "fields": fields, "maxResults": a.max, "responseContentFormat": "adf"},
    )
    issues = res.get("issues") or [] if isinstance(res, dict) else res
    if a.json:
        print(json.dumps(res, indent=2, ensure_ascii=False))
        return
    if not issues:
        print(f"일치하는 카드가 없습니다: {a.jql}")
        return
    cols = ["key"] + [f for f in fields if f != "summary"] + ["summary"]
    rows = [[i.get("key", "-")] + [_fv((i.get("fields") or {}).get(c)) for c in cols[1:]] for i in issues]
    widths = [max(len(c), *(len(r[n]) for r in rows)) for n, c in enumerate(cols)]
    # The last column absorbs the rest of the line, so it is never padded.
    line = lambda cells: "  ".join(
        c.ljust(widths[n]) if n < len(cells) - 1 else c for n, c in enumerate(cells)
    )
    print(line([c.upper() for c in cols]))
    for r in rows:
        print(line(r))
    print(f"\n{len(rows)}건")
    if isinstance(res, dict) and res.get("nextPageToken"):
        print("더 있습니다 — JQL을 좁히거나 -n 을 올리세요.")


def cmd_info(mcp, a):
    issue = mcp.call(
        "getJiraIssue",
        {"issueIdOrKey": a.issue, "fields": CARD_FIELDS, "responseContentFormat": "adf"},
    )
    fields = issue.get("fields") or {}
    if a.json:
        print(json.dumps(issue, indent=2, ensure_ascii=False))
        return
    print(f"{'key':<10} {issue.get('key', a.issue)}")
    for name in CARD_FIELDS:
        print(f"{name:<10} {_fv(fields.get(name))}")


def _comment_head(c):
    """One header line per comment: who wrote it, when, and the id an API call needs."""
    author = (c.get("author") or {}).get("displayName") or "-"
    edited = "  (수정됨)" if c.get("updated") and c.get("updated") != c.get("created") else ""
    return f"{author}  {_fv(c.get('created'))}{edited}  id={c.get('id', '-')}"


def _comment_doc(a):
    """A comment is a whole `doc`: --text wraps one paragraph, otherwise stdin carries the JSON."""
    if a.text is not None:
        para = {"type": "paragraph", "content": [{"type": "text", "text": a.text}]}
        return {"type": "doc", "version": 1, "content": [para]}
    raw = sys.stdin.read()
    if not raw.strip():
        raise Fail("--add/--edit reads the comment's ADF doc from stdin, and stdin was empty")
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as e:
        raise Fail(f"stdin is not valid JSON: {e}")
    if not isinstance(doc, dict) or doc.get("type") != "doc":
        raise Fail("a comment body must be a top-level ADF `doc` node")
    return doc


def cmd_comments(mcp, a):
    if a.add or a.edit:
        res = mcp.put_comment(a.issue, _comment_doc(a), a.edit)
        if isinstance(res, dict) and res.get("id"):
            print(f"✓ {'수정' if a.edit else '작성'}했습니다  {_comment_head(res)}")
        else:
            print(res)
        return
    field = mcp.get_comments(a.issue)
    items = field.get("comments") or []
    if a.json:
        print(json.dumps(field, indent=2, ensure_ascii=False))
        return
    if not items:
        print(f"{a.issue} 에는 댓글이 없습니다.")
        return
    for n, c in enumerate(items):
        print(f"{'\u2500' * 72}\n#{n}  {_comment_head(c)}")
        body = c.get("body")
        print(render(body) if isinstance(body, dict) else (body or "(본문 없음)"))
    total = field.get("total", len(items))
    tail = f" (전체 {total}건 중 — 나머지는 웹 UI에서 확인해 주세요)" if total > len(items) else ""
    print(f"\n{len(items)}건{tail}")


COMMENTS_HELP = """\
Prints every comment on the card, oldest first, as the same lossy plain-text view
that `jira show --rendered` uses. `--add` and `--edit` write one comment right away,
with no queue, because a comment has no existing body to pre-flight against.

    (default)   one header line per comment, then the body as plain text
    --json      the raw `comment` field, ADF bodies included
    --add       post a new comment; the body is an ADF `doc` on stdin
    --edit ID   replace comment ID's body; the body is an ADF `doc` on stdin
    --text STR  with --add/--edit: one plain paragraph instead of stdin

The header carries the author, the creation time, `(수정됨)` when the comment was
edited afterwards, and the comment id.

EXAMPLES
    jira comments -i PROJ-1
    jira comments -i PROJ-1 --json
    jira comments -i PROJ-1 --add --text '재현 확인했습니다.'
    jira show -i PROJ-1 --json | jira comments -i PROJ-1 --add
    jira comments -i PROJ-1 --edit 10042 --text '(수정) 재현 확인했습니다.'
"""


def register(sub, fmt):
    se = sub.add_parser("search", help="run a JQL query, one row per card")
    se.add_argument("jql", help="a JQL query, e.g. 'assignee = currentUser() AND status != Done'")
    se.add_argument("-n", "--max", type=int, default=50, metavar="N", help="max rows, 1-100 (default 50)")
    se.add_argument("--fields", metavar="A,B", help="comma-separated Jira field names to show")
    se.add_argument("--json", action="store_true", help="print the raw MCP response")
    se.set_defaults(fn=cmd_search)

    nf = sub.add_parser("info", help="one card's status, assignee, parent and labels")
    nf.add_argument("-i", "--issue", required=True, metavar="KEY")
    nf.add_argument("--json", action="store_true", help="print the raw MCP response")
    nf.set_defaults(fn=cmd_info)

    cm = sub.add_parser(
        "comments", help="print, post or edit a card's comments", epilog=COMMENTS_HELP, formatter_class=fmt
    )
    cm.add_argument("-i", "--issue", required=True, metavar="KEY")
    cm.add_argument("--json", action="store_true", help="print the raw comment field instead")
    w = cm.add_mutually_exclusive_group()
    w.add_argument("--add", action="store_true", help="post a new comment from an ADF doc on stdin")
    w.add_argument("--edit", metavar="ID", help="replace comment ID's body from an ADF doc on stdin")
    cm.add_argument("--text", metavar="STR", help="with --add/--edit: one plain paragraph instead of stdin")
    cm.set_defaults(fn=cmd_comments)
