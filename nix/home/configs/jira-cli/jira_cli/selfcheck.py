"""The offline assertions behind `jira selfcheck`, run against the vendored fixture."""

import copy
import json
import os

from jira_cli.adf import _esc, _parts, _text_of, apply_op, render, resolve, select, to_xml, validate
from jira_cli.cards import _comment_head, _fv
from jira_cli.flow import _arrow, _chain, _match_status, _routes

# ------------------------------------------------------------------ self-check


FIXTURE = os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(__file__))), "fixture.adf.json")


def cmd_selfcheck(mcp, a):
    with open(FIXTURE) as f:
        doc = json.load(f)

    checks = [
        ('heading[level="2"]', ["/content/3", "/content/7"]),
        ("tableRow:nth-child(2) tableCell:nth-child(3)", ["/content/5/content/1/content/2"]),
        ('text[mark~="strong"]', ["/content/2/content/1"]),
        ('table[isNumberColumnEnabled="false"]', ["/content/5"]),
    ]
    for css, expect in checks:
        got = select(doc, css)
        assert got == expect, f"{css}: expected {expect}, got {got}"
        print(f"  ok  {css} → {got}")

    assert validate(doc) is None, f"fixture must validate cleanly: {validate(doc)}"
    print("  ok  fixture validates with zero errors")

    bad = copy.deepcopy(doc)
    resolve(bad, "/content/2/content/1")[2]["content"] = [{"type": "text", "text": "illegal"}]
    err = validate(bad)
    assert err and err.startswith("/content/2/content/1"), f"expected the text node blamed, got {err}"
    print(f"  ok  grafted child on a text node → {err.split(':')[0]}")

    # Index shift: deleting /content/0 must move /content/1 down, and the pointer
    # sort must apply the deeper edit before the shallower one.
    d = copy.deepcopy(doc)
    apply_op(d, "/content/0", "delete", None)
    assert d["content"][0]["type"] == "heading", "delete did not shift later siblings"
    apply_op(d, "/content/0", "after", {"type": "paragraph", "content": [{"type": "text", "text": "x"}]})
    assert _text_of(d["content"][1]) == "x", "--after landed at the wrong index"
    print("  ok  delete shifts siblings, --after lands at index+1")

    assert _esc("a/b~c") == "a~1b~0c" and _parts("/a~1b") == ["a/b"], "pointer escaping is not round-tripping"
    print("  ok  pointer segments escape and unescape")

    xml = to_xml(doc)
    assert 'isNumberColumnEnabled="false"' in xml, "a bool attr must print ADF's literal, not Python's"
    assert '<heading ptr="/content/3" level="2">' in xml, f"heading did not project:\n{xml[:200]}"
    assert to_xml(doc, "/content/3").startswith('<heading ptr="/content/3"'), "--pointer lost the absolute ptr"
    pretty = json.dumps(doc, indent=2, ensure_ascii=False)
    assert len(xml) < len(pretty), f"xml view must be smaller: {len(xml)} vs {len(pretty)}"
    print(f"  ok  xml view projects ptr and attrs, {100 - 100 * len(xml) // len(pretty)}% smaller than the JSON")

    txt = render(doc)
    assert "## 두 번째 단계" in txt, f"heading level did not become hashes:\n{txt[:200]}"
    assert "***강조***" in txt or "**강조**" in txt, f"marks did not wrap:\n{txt[:300]}"
    assert "ptr=" not in txt and "|---" in txt, "rendered view must drop pointers and keep a table"
    assert len(txt) < len(xml), f"rendered view must be the cheapest: {len(txt)} vs {len(xml)}"
    print(f"  ok  rendered view is plain text, {100 - 100 * len(txt) // len(pretty)}% smaller than the JSON")

    # A two-hop chain is the whole point of `flow`/`move`: nothing on the card itself
    # can express it, so the BFS over the sampled graph is what must not regress.
    edges = {
        "To Do": [{"to": "In Progress", "id": "31", "name": "In Progress", "conditional": False, "screen": False}],
        "In Progress": [{"to": "Dev Done", "id": "111", "name": "Dev Done", "conditional": False, "screen": False}],
        "Dev Done": None,
    }
    assert _chain(edges, "To Do", "Dev Done") == ["To Do", "In Progress", "Dev Done"], "two-hop chain lost"
    assert _chain(edges, "To Do", "To Do") == ["To Do"], "a same-status chain must be the start alone"
    assert _chain(edges, "Dev Done", "To Do") is None, "an unexplored status must not yield a path"
    assert _match_status("dev done", edges) == "Dev Done", "status matching must ignore case"
    assert _match_status("Progress", edges) == "In Progress", "a unique substring must resolve"
    routes = _routes(edges, "To Do")
    assert routes == {"In Progress": ["31"], "Dev Done": ["31", "111"]}, f"routes wrong: {routes}"
    assert _arrow(routes["In Progress"]) == "--31-->", "one hop must render with dashes"
    assert _arrow(routes["Dev Done"]) == "==31==111==>", "a chain must render every id in order"
    assert _arrow(routes.get("In QA")) == "~~???~~>", "a status with no known route must render as unknown"
    print("  ok  status chain BFS, route arrows, status-name matching")

    assert _fv({"displayName": "홍길동"}) == "홍길동" and _fv(None) == "-", "field flattening broke"
    assert _fv([{"name": "a"}, {"name": "b"}]) == "a,b", "list field did not join"
    print("  ok  search fields flatten to one display string")

    head = _comment_head(
        {
            "id": "1234",
            "created": "2026-01-02T03:04:05.000+0900",
            "updated": "2026-01-03T03:04:05.000+0900",
            "author": {"displayName": "홍길동"},
        }
    )
    assert head == "홍길동  2026-01-02 03:04  (수정됨)  id=1234", f"comment header wrong: {head}"
    assert "(수정됨)" not in _comment_head({"created": "x", "updated": "x"}), "an unedited comment must not be flagged"
    print("  ok  comment header names author, time, edit flag and id")

    print("\n✓ selfcheck 통과")


def register(sub, fmt):
    sub.add_parser("selfcheck", help="run the offline assertions").set_defaults(fn=cmd_selfcheck)
