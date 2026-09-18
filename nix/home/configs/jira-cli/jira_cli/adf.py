"""The ADF layer: XML projection and CSS selection, JSON pointers and ops, schema
validation, the rendered view, and the `show`, `types`, `media ls` and `schema update` commands."""

import copy
import json
import os
import subprocess

from cssselect import GenericTranslator
from jsonschema import Draft4Validator
from jsonschema.exceptions import best_match
from lxml import etree

from jira_cli.auth import CONFIG_DIR, Fail, _http

SCHEMA_URL = "https://unpkg.com/@atlaskit/adf-schema@latest/dist/json-schema/v1/full.json"
LOCAL_SCHEMA = os.path.join(CONFIG_DIR, "adf-schema.json")
VENDORED_SCHEMA = os.path.join(
    os.path.dirname(os.path.dirname(os.path.realpath(__file__))), "adf-schema-56.7.3.json"
)


# -------------------------------------------------------------------- selector


def _esc(seg):
    return str(seg).replace("~", "~0").replace("/", "~1")


def _build(node, ptr="", parent=None):
    tag = node.get("type", "unknown") if isinstance(node, dict) else "unknown"
    el = etree.Element(tag) if parent is None else etree.SubElement(parent, tag)
    el.set("ptr", ptr)
    for k, v in (node.get("attrs") or {}).items():
        # ADF's own literal, not Python's repr: a bool must read `false`, never
        # `False`, because this string is both what --xml prints and what a CSS
        # attribute selector compares against.
        el.set(k, v if isinstance(v, str) else json.dumps(v, ensure_ascii=False))
    # Space-separated so `text[mark~="strong"]` matches a node carrying several marks.
    marks = [m.get("type", "") for m in (node.get("marks") or [])]
    if marks:
        el.set("mark", " ".join(marks))
    if "text" in node:
        el.text = node["text"]
    for i, child in enumerate(node.get("content") or []):
        _build(child, f"{ptr}/content/{_esc(i)}", el)
    return el


def to_xml(doc, ptr=None):
    """Serialize the selector's own view of the tree.

    The tags, the attributes and the `ptr` values printed here are exactly what a
    CSS selector matches against, so this doubles as the map for writing one. It
    is a read-only view: marks arrive as bare type names with their own attrs
    dropped, so nothing here round-trips back into ADF.
    """
    root = _build(doc)
    if ptr:
        resolve(doc, ptr)  # names the bad pointer before the xpath finds nothing
        root = root.xpath(f'//*[@ptr="{ptr}"]')[0]
    return etree.tostring(root, pretty_print=True, encoding="unicode").rstrip("\n")



# ----------------------------------------------------------------- rendered view

# Wrapping marks only. `link` carries an href and is handled apart, and every other
# mark (textColor, backgroundColor, subsup, …) has no plain-text form worth faking.
MARK_WRAP = {"strong": "**", "em": "*", "code": "`", "strike": "~~", "underline": "_"}


def _inline(node):
    t = node.get("type")
    attrs = node.get("attrs") or {}
    if t == "text":
        s = node.get("text", "")
        for m in node.get("marks") or []:
            if m.get("type") == "link":
                s = f"[{s}]({(m.get('attrs') or {}).get('href', '')})"
            elif m.get("type") in MARK_WRAP:
                w = MARK_WRAP[m["type"]]
                s = f"{w}{s}{w}"
        return s
    if t == "hardBreak":
        return "\n"
    if t == "mention":
        return "@" + (attrs.get("text") or "").lstrip("@")
    if t == "emoji":
        return attrs.get("shortName") or attrs.get("text") or ""
    if t == "date":
        return attrs.get("timestamp", "")
    if t == "status":
        return f"[{(attrs.get('text') or '').upper()}]"
    if t in ("inlineCard", "blockCard", "embedCard"):
        return attrs.get("url", "")
    if t == "media":
        ref = attrs.get("url") or attrs.get("id", "")
        return f"![{attrs.get('type', 'file')}:{ref}]"
    return "".join(_inline(c) for c in node.get("content") or [])


def _prefix(body, first, rest):
    lines = body.splitlines() or [""]
    return "\n".join((first if i == 0 else rest) + line for i, line in enumerate(lines))


def _cell_text(cell):
    return " ".join(_inline(c).replace("\n", " ") for c in cell.get("content") or []).strip()


def _render_table(node):
    rows = [r.get("content") or [] for r in node.get("content") or []]
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    out = []
    for i, row in enumerate(rows):
        cells = [_cell_text(c).replace("|", "\\|") for c in row] + [""] * (width - len(row))
        out.append("| " + " | ".join(cells) + " |")
        if i == 0:
            out.append("|" + "---|" * width)
    return "\n".join(out)


def render(node, indent=""):
    """A lossy plain-text view of a card, for reading only.

    Marks collapse to markdown and pointers are absent, so this is the cheapest form
    to read and the one form that must never be edited and pushed back. It walks the
    ADF rather than the lxml projection, so a link keeps its href where `--xml` shows
    the bare mark name. `--xml` is the view that carries the selector surface.
    """
    t = node.get("type")
    attrs = node.get("attrs") or {}
    kids = node.get("content") or []
    if t == "doc":
        return "\n\n".join(x for x in (render(c) for c in kids) if x.strip())
    if t == "paragraph":
        return indent + _inline(node)
    if t == "heading":
        return indent + "#" * int(attrs.get("level", 1)) + " " + _inline(node)
    if t == "codeBlock":
        # ADF stores a code block's trailing newline; the closing fence supplies it here.
        return _prefix(f"```{attrs.get('language', '')}\n{_inline(node).rstrip(chr(10))}\n```", indent, indent)
    if t == "rule":
        return indent + "---"
    if t == "blockquote":
        return _prefix("\n".join(render(c) for c in kids), indent + "> ", indent + "> ")
    if t in ("panel", "expand", "nestedExpand"):
        label = attrs.get("panelType") or attrs.get("title") or t
        body = "\n".join(render(c) for c in kids)
        return _prefix(f"[{label}]\n{body}", indent, indent)
    if t in ("bulletList", "orderedList"):
        ordered = t == "orderedList"
        start = int(attrs.get("order", 1)) if ordered else 1
        out = []
        for i, item in enumerate(kids):
            marker = f"{start + i}. " if ordered else "- "
            body = "\n".join(render(c) for c in item.get("content") or [])
            out.append(_prefix(body, indent + marker, indent + " " * len(marker)))
        return "\n".join(out)
    if t == "taskList":
        out = []
        for item in kids:
            box = "[x] " if (item.get("attrs") or {}).get("state") == "DONE" else "[ ] "
            out.append(_prefix(_inline(item), indent + box, indent + "    "))
        return "\n".join(out)
    if t == "table":
        return _prefix(_render_table(node), indent, indent)
    if t in ("mediaSingle", "mediaGroup"):
        return indent + " ".join(_inline(c) for c in kids)
    return indent + _inline(node) if kids or "text" in node else f"{indent}<{t}>"


def select(doc, css):
    root = _build(doc)
    try:
        xpath = GenericTranslator().css_to_xpath(css, prefix="descendant-or-self::")
    except Exception as e:
        raise Fail(f"bad selector {css!r}: {type(e).__name__}: {e}")
    return [el.get("ptr") for el in root.xpath(xpath)]


def select_jq(doc, expr):
    """Escape hatch: filter nodes by a jq expression evaluated against each node."""
    nodes = []

    def walk(node, ptr=""):
        nodes.append((ptr, node))
        for i, c in enumerate(node.get("content") or []):
            walk(c, f"{ptr}/content/{_esc(i)}")

    walk(doc)
    payload = "\n".join(json.dumps({"ptr": p, "node": n}) for p, n in nodes)
    try:
        proc = subprocess.run(
            ["jq", "-c", f"select(.node | ({expr})) | .ptr"],
            input=payload, capture_output=True, text=True,
        )
    except FileNotFoundError:
        raise Fail("--jq needs the `jq` binary on PATH")
    if proc.returncode != 0:
        raise Fail(f"jq exited {proc.returncode}:\n{proc.stderr.strip()}")
    return [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]


# --------------------------------------------------------------- JSON pointers


def _parts(ptr):
    if not ptr:
        return []
    return [s.replace("~1", "/").replace("~0", "~") for s in ptr.lstrip("/").split("/")]


def _sortkey(ptr):
    return [(int(p) if p.isdigit() else -1, p) for p in _parts(ptr)]


def resolve(doc, ptr):
    """Return (container, key, value) for a pointer; container is None at the root."""
    cur, container, key = doc, None, None
    for p in _parts(ptr):
        container = cur
        key = int(p) if isinstance(cur, list) else p
        try:
            cur = cur[key]
        except (KeyError, IndexError, TypeError):
            raise Fail(f"pointer {ptr} does not resolve in this document")
    return container, key, cur


OPS = ("replace", "before", "after", "append", "delete", "text")


def apply_op(doc, ptr, op, payload):
    container, key, node = resolve(doc, ptr)
    if container is None:
        raise Fail("refusing to edit the document root — select a node inside it")
    if op == "replace":
        container[key] = copy.deepcopy(payload)
    elif op == "delete":
        del container[key]
    elif op in ("before", "after"):
        if not isinstance(container, list):
            raise Fail(f"{ptr} has no sibling list — --before/--after need a content child")
        container.insert(key + (1 if op == "after" else 0), copy.deepcopy(payload))
    elif op == "append":
        node.setdefault("content", []).append(copy.deepcopy(payload))
    elif op == "text":
        if "text" in node:
            node["text"] = payload
        else:
            node["content"] = [{"type": "text", "text": payload}]
    else:
        raise Fail(f"unknown op {op!r}")


# ------------------------------------------------------------------ validation


def _schema():
    path = LOCAL_SCHEMA if os.path.exists(LOCAL_SCHEMA) else VENDORED_SCHEMA
    if not os.path.exists(path):
        raise Fail(f"no ADF schema at {path} — run `jira schema update`")
    with open(path) as f:
        return json.load(f)


def _node_validators(schema):
    """Map an ADF node type to a validator for that type alone.

    The whole-document schema is one giant anyOf, so its top-level error blames the
    innocent parent and dumps its entire JSON. Validating each node against only the
    definitions that declare its own `type` is what makes the blame land on the node.
    """
    defs = schema["definitions"]
    by_type = {}
    for name, d in defs.items():
        prop = (d.get("properties") or {}).get("type")
        if not isinstance(prop, dict):
            continue
        for t in prop.get("enum") or ([prop["const"]] if "const" in prop else []):
            by_type.setdefault(t, []).append(name)
    cache = {}

    def validator(t):
        if t not in cache:
            names = by_type.get(t)
            sub = (
                {"anyOf": [{"$ref": f"#/definitions/{n}"} for n in names], "definitions": defs}
                if names
                else {"not": {}}
            )
            cache[t] = Draft4Validator(sub)
        return cache[t]

    return validator


def validate(doc):
    """Return None when the document is valid ADF, else a one-line blame report."""
    schema = _schema()
    if not list(Draft4Validator(schema).iter_errors(doc)):
        return None

    validator = _node_validators(schema)
    worst = None

    def walk(node, ptr=""):
        nonlocal worst
        if isinstance(node, dict):
            for i, child in enumerate(node.get("content") or []):
                walk(child, f"{ptr}/content/{_esc(i)}")
        if not ptr:
            return
        if not isinstance(node, dict) or "type" not in node:
            msg = "not an ADF node — every node needs a `type`"
        else:
            err = best_match(validator(node["type"]).iter_errors(node))
            if err is None:
                return
            msg = err.message
        if worst is None or ptr.count("/") > worst[0].count("/"):
            worst = (ptr, msg)

    walk(doc)
    if worst:
        return f"{worst[0]}: {worst[1][:300]}"
    err = best_match(Draft4Validator(schema).iter_errors(doc))
    ptr = "/" + "/".join(str(p) for p in err.absolute_path) if err.absolute_path else "(root)"
    return f"{ptr}: {err.message[:300]}"


def _summary(node):
    if not isinstance(node, dict):
        return json.dumps(node, ensure_ascii=False)[:60]
    txt = _text_of(node)
    return f"{node.get('type')} {txt[:50]!r}" if txt else str(node.get("type"))


def _shown(node):
    """A drift line shows the node's text; a node without text shows its JSON instead."""
    txt = _text_of(node)
    return repr(txt) if txt else json.dumps(node, ensure_ascii=False)[:120]


def _text_of(node):
    if not isinstance(node, dict):
        return ""
    if "text" in node:
        return node["text"]
    return "".join(_text_of(c) for c in (node.get("content") or []))


# -------------------------------------------------------------------- commands


def cmd_show(mcp, a):
    doc = mcp.get_doc(a.issue)
    if not (a.json or a.rendered):
        print(to_xml(doc, a.pointer))
        return
    node = resolve(doc, a.pointer)[2] if a.pointer else doc
    print(render(node) if a.rendered else json.dumps(node, indent=2, ensure_ascii=False))


def cmd_media(mcp, a):
    doc = mcp.get_doc(a.issue)
    ptrs = select(doc, "media")
    if not ptrs:
        print("이 카드에는 media 노드가 없습니다. 웹 UI에서 먼저 업로드해 주세요.")
        return
    for p in ptrs:
        attrs = resolve(doc, p)[2].get("attrs", {})
        ident = attrs.get("id") or attrs.get("url", "")
        print(f"{p:<32} {attrs.get('type','file'):<9} {ident}")


def cmd_schema_update(mcp, a):
    st, body, _ = _http(SCHEMA_URL)
    if st != 200:
        raise Fail(f"schema download failed: HTTP {st}\n{body[:400]}")
    doc = json.loads(body)
    os.makedirs(CONFIG_DIR, mode=0o700, exist_ok=True)
    with open(LOCAL_SCHEMA, "w") as f:
        json.dump(doc, f)
    print(f"✓ {LOCAL_SCHEMA} 갱신 — 이 파일이 있으면 번들 스키마보다 우선합니다.")


# ---------------------------------------------------------------- node types


def cmd_types(mcp, a):
    """Answer "what node types exist" and "what attrs does one take" from the schema.

    An agent writing a selector or an ADF node has to guess the vocabulary otherwise,
    and the alternative is reading a 74k JSON schema. Derived, so it cannot go stale.
    """
    schema = _schema()
    defs = schema["definitions"]
    by_type, marks = {}, set()
    for name, d in defs.items():
        prop = (d.get("properties") or {}).get("type")
        if not isinstance(prop, dict):
            continue
        for t in prop.get("enum") or ([prop["const"]] if "const" in prop else []):
            by_type.setdefault(t, []).append(name)
            if name.endswith("_mark"):
                marks.add(t)

    if not a.type:
        nodes = sorted(t for t in by_type if t not in marks)
        # Marks are listed apart because they are never element names — they reach a
        # selector only through the `mark` attribute, as text[mark~="strong"].
        print("NODES (use as the element name in a selector)")
        print("  " + "  ".join(nodes))
        print('\nMARKS (use as text[mark~="…"])')
        print("  " + "  ".join(sorted(marks)))
        print(f"\n{len(nodes)} nodes, {len(marks)} marks — `jira types <name>` prints one's attrs.")
        return

    if a.type not in by_type:
        near = [t for t in sorted(by_type) if a.type.lower() in t.lower()]
        raise Fail(f"no node type {a.type!r}" + (f" — did you mean: {', '.join(near)}" if near else ""))

    for name in by_type[a.type]:
        d = defs[name]
        attrs = (d.get("properties") or {}).get("attrs") or {}
        print(f"# {name}")
        print(f"  required : {d.get('required', [])}")
        print(f"  attrs    : {json.dumps(attrs, ensure_ascii=False)[:800] if attrs else '(none)'}")
        print(f"  content  : {'yes' if 'content' in (d.get('properties') or {}) else 'no'}\n")


SHOW_HELP = """\
Three views of the same card. The default is the XML projection, which is the map a
selector is written against — the element name is the node's `type`, its `attrs` are
attributes, `mark` holds the marks, and `ptr` is the JSON pointer.

    --xml       (default) the selector surface, ~40% smaller than the JSON
    --json      raw ADF — the shape `jira edit queue` reads on stdin
    --rendered  a lossy plain-text reading view: no attrs, no pointers, cheapest

Read with the default, copy a node to edit with --json, and skim a long card with
--rendered. --rendered reads the ADF directly, so it keeps link targets and media
ids, but it carries no pointers and no node attrs — nothing there can be edited and
pushed back. Every write goes through --json into `jira edit queue`.

EXAMPLES
    jira show -i PROJ-1
    jira show -i PROJ-1 --rendered
    jira show -i PROJ-1 --pointer /content/3 --json
"""


def register(sub, fmt):
    sh = sub.add_parser("show", help="print a card's ADF as the selector's XML view", epilog=SHOW_HELP, formatter_class=fmt)
    sh.add_argument("-i", "--issue", required=True, metavar="KEY")
    sh.add_argument("--pointer", metavar="PTR", help="print only this JSON pointer, e.g. /content/3")
    view = sh.add_mutually_exclusive_group()
    view.add_argument("--xml", action="store_true", help="the selector's XML view (the default; named so it can be explicit)")
    view.add_argument("--json", action="store_true", help="print raw ADF JSON instead — the shape stdin wants")
    view.add_argument("--rendered", action="store_true", help="print a lossy plain-text reading view, no pointers")
    sh.set_defaults(fn=cmd_show)


def register_tools(sub, fmt):
    """`types`, `media` and `schema` sit after the card and workflow commands in the listing."""
    ty = sub.add_parser("types", help="list ADF node types, or one type's attrs")
    ty.add_argument("type", nargs="?", help="a node type name, e.g. panel")
    ty.set_defaults(fn=cmd_types)

    md = sub.add_parser("media", help="media node tools").add_subparsers(dest="sub", required=True)
    ml = md.add_parser("ls", help="list media nodes already on the card")
    ml.add_argument("-i", "--issue", required=True, metavar="KEY")
    ml.set_defaults(fn=cmd_media)

    sc = sub.add_parser("schema", help="ADF schema tools").add_subparsers(dest="sub", required=True)
    sc.add_parser("update", help="refresh the local ADF schema").set_defaults(fn=cmd_schema_update)
