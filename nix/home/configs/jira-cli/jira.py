#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["lxml", "cssselect", "jsonschema"]
# ///
"""Fine-grained ADF editing for Jira cards, over the Atlassian MCP endpoint.

Select a node inside a card's Atlassian Document Format tree with a CSS selector,
stage the edit, and flush a batch of edits as a single write.

Auth is Dynamic Client Registration plus PKCE, so there is no app to register and no
secret to rotate. See `docs/src/jira-cli.md` for the layer map and the design rationale.
"""

import argparse
import base64
import copy
import hashlib
import http.server
import json
import os
import secrets
import socketserver
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

from cssselect import GenericTranslator
from jsonschema import Draft4Validator
from jsonschema.exceptions import best_match
from lxml import etree

MCP_URL = "https://mcp.atlassian.com/v1/mcp"
REGISTER_URL = "https://cf.mcp.atlassian.com/v1/register"
AUTHORIZE_URL = "https://mcp.atlassian.com/v1/authorize"
TOKEN_URL = "https://cf.mcp.atlassian.com/v1/token"
SCHEMA_URL = "https://unpkg.com/@atlaskit/adf-schema@latest/dist/json-schema/v1/full.json"
PROTOCOL_VERSION = "2025-06-18"
SCOPES = "read:jira-work write:jira-work offline_access"
CALLBACK_PORT = 8765

CONFIG_DIR = os.path.expanduser("~/.config/jira-cli")
CRED_PATH = os.path.join(CONFIG_DIR, "credentials.json")
QUEUE_PATH = os.path.join(CONFIG_DIR, "queue.json")
LOCAL_SCHEMA = os.path.join(CONFIG_DIR, "adf-schema.json")
FLOW_PATH = os.path.join(CONFIG_DIR, "workflow.json")
VENDORED_SCHEMA = os.path.join(os.path.dirname(os.path.realpath(__file__)), "adf-schema-56.7.3.json")

# Cloudflare fronts the MCP hosts and answers the default Python-urllib agent with
# HTTP 403 code 1010. Any non-default User-Agent gets through.
UA = "ranolp-jira-cli"


class Fail(SystemExit):
    def __init__(self, msg):
        super().__init__(f"✗ {msg}")


# ---------------------------------------------------------------- HTTP helpers


def _http(url, data=None, headers=None, method="GET", timeout=60):
    """Return (status, body_text). Never raises on an HTTP error status.

    The caller always gets the body, because a bare status code costs a whole
    debugging round-trip on an endpoint whose rejections name the exact field.
    """
    h = {"User-Agent": UA, "Accept": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(), dict(e.headers)


def _post_json(url, payload, headers=None):
    st, body, hdr = _http(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    try:
        return st, json.loads(body) if body.strip() else {}, hdr
    except json.JSONDecodeError:
        return st, body, hdr


def _post_form(url, fields):
    st, body, _ = _http(
        url,
        data=urllib.parse.urlencode(fields).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        return st, json.loads(body) if body.strip() else {}
    except json.JSONDecodeError:
        return st, body


# ------------------------------------------------------------------------ auth


def _read_creds():
    if not os.path.exists(CRED_PATH):
        return None
    with open(CRED_PATH) as f:
        return json.load(f)


def _write_creds(creds):
    os.makedirs(CONFIG_DIR, mode=0o700, exist_ok=True)
    fd = os.open(CRED_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(creds, f, indent=2)


def _register_client():
    st, reg, _ = _post_json(
        REGISTER_URL,
        {
            "client_name": "ranolp-jira-cli",
            "redirect_uris": [f"http://localhost:{CALLBACK_PORT}/callback"],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        },
    )
    if st not in (200, 201) or not isinstance(reg, dict) or "client_id" not in reg:
        raise Fail(f"client registration failed: HTTP {st}\n{reg}")
    return reg["client_id"]


def login(force=False):
    creds = _read_creds() or {}
    client_id = None if force else creds.get("client_id")
    if not client_id:
        client_id = _register_client()
        print(f"  registered client_id={client_id}")

    redirect = f"http://localhost:{CALLBACK_PORT}/callback"
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(24)
    url = AUTHORIZE_URL + "?" + urllib.parse.urlencode(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect,
            "state": state,
            "scope": SCOPES,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )

    print("브라우저에서 승인해 주세요:")
    print(f"  {url}")
    webbrowser.open(url)

    got = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if "error" in q:
                got["err"] = f"authorization error: {q}"
            elif q.get("state", [None])[0] != state:
                got["err"] = "state mismatch — possible CSRF, aborting"
            else:
                got["code"] = q.get("code", [""])[0]
            msg = got.get("err") or "Authorized. You can close this tab."
            body = f"<html><body style='font:16px sans-serif;padding:3rem'>{msg}</body></html>".encode()
            self.send_response(400 if "err" in got else 200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", CALLBACK_PORT), Handler) as httpd:
        httpd.timeout = 300
        httpd.handle_request()

    if "err" in got:
        raise Fail(got["err"])
    if not got.get("code"):
        raise Fail("no authorization code arrived within 300s")

    st, tok = _post_form(
        TOKEN_URL,
        {
            "grant_type": "authorization_code",
            "code": got["code"],
            "redirect_uri": redirect,
            "client_id": client_id,
            "code_verifier": verifier,
        },
    )
    if st != 200 or not isinstance(tok, dict) or "access_token" not in tok:
        raise Fail(f"token exchange failed: HTTP {st}\n{tok}")

    creds.update(tok)
    creds["client_id"] = client_id
    creds["obtained_at"] = int(time.time())
    _write_creds(creds)
    print(f"✓ 인증 완료 — {CRED_PATH} (0600), scope={tok.get('scope')}")
    return creds


def _refresh(creds):
    if not creds.get("refresh_token"):
        raise Fail("no refresh_token — run `jira login`")
    st, tok = _post_form(
        TOKEN_URL,
        {
            "grant_type": "refresh_token",
            "refresh_token": creds["refresh_token"],
            "client_id": creds["client_id"],
        },
    )
    if st != 200 or not isinstance(tok, dict) or "access_token" not in tok:
        raise Fail(f"token refresh failed: HTTP {st}\n{tok}\n  run `jira login` to re-authorize")
    creds.update(tok)
    creds["obtained_at"] = int(time.time())
    _write_creds(creds)
    return creds


def _access_token():
    creds = _read_creds()
    if not creds:
        raise Fail(f"no credentials at {CRED_PATH} — run `jira login`")
    expiry = creds.get("obtained_at", 0) + creds.get("expires_in", 0)
    if not creds.get("access_token") or (creds.get("obtained_at") and time.time() > expiry - 60):
        creds = _refresh(creds)
    return creds["access_token"]


# ------------------------------------------------------------------- transport


class MCP:
    def __init__(self):
        self.session = None
        self.ready = False
        self.cloud_id = None

    def _rpc(self, method, params=None, notify=False, retry=True):
        payload = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        if not notify:
            payload["id"] = 1
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {_access_token()}",
            "MCP-Protocol-Version": PROTOCOL_VERSION,
        }
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        st, body, hdr = _http(MCP_URL, data=json.dumps(payload).encode(), headers=headers, method="POST")
        if st == 401 and retry:
            _refresh(_read_creds())
            self.session, self.ready = None, False
            self.connect()
            return self._rpc(method, params, notify, retry=False)
        if st not in (200, 202):  # a notification is answered 202 with an empty body
            raise Fail(f"MCP {method} failed: HTTP {st}\n{body}")
        if not self.session:
            self.session = hdr.get("Mcp-Session-Id") or hdr.get("mcp-session-id")
        return {} if notify else _unwrap(body)

    def connect(self):
        if self.ready:
            return
        self._rpc(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "ranolp-jira-cli", "version": "1.0.0"},
            },
        )
        self._rpc("notifications/initialized", {}, notify=True)
        self.ready = True

    def call(self, name, args, with_cloud=True):
        self.connect()
        if with_cloud:
            args = {"cloudId": self.cloudid(), **args}
        res = self._rpc("tools/call", {"name": name, "arguments": args}).get("result", {})
        text = "\n".join(c.get("text", "") for c in res.get("content", []))
        if res.get("isError"):
            raise Fail(f"{name} rejected the call:\n{text}")
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text

    def cloudid(self):
        if self.cloud_id:
            return self.cloud_id
        env = os.environ.get("JIRA_CLOUD_ID")
        creds = _read_creds() or {}
        self.cloud_id = env or creds.get("cloud_id")
        if self.cloud_id:
            return self.cloud_id
        sites = self.call("getAccessibleAtlassianResources", {}, with_cloud=False)
        if not isinstance(sites, list) or not sites:
            raise Fail(f"no accessible Atlassian sites returned:\n{sites}")
        if len(sites) > 1:
            listing = "\n".join(f"    {s.get('url')}  {s.get('id')}" for s in sites)
            raise Fail(f"multiple sites — set JIRA_CLOUD_ID to one of:\n{listing}")
        self.cloud_id = sites[0]["id"]
        creds["cloud_id"] = self.cloud_id
        _write_creds(creds)
        return self.cloud_id

    def get_doc(self, key):
        issue = self.call(
            "getJiraIssue",
            {"issueIdOrKey": key, "fields": ["description"], "responseContentFormat": "adf"},
        )
        doc = (issue.get("fields") or {}).get("description")
        if not isinstance(doc, dict):
            raise Fail(f"{key} has no ADF description (got {type(doc).__name__})")
        return doc

    def put_doc(self, key, doc):
        return self.call(
            "editJiraIssue",
            {"issueIdOrKey": key, "fields": {"description": doc}, "contentFormat": "adf"},
        )


def _unwrap(body):
    """MCP answers either plain JSON or an SSE stream; take the first data frame."""
    for line in body.splitlines():
        if line.startswith("data: "):
            return json.loads(line[6:])
    return json.loads(body) if body.strip() else {}


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


def cmd_show(mcp, a):
    doc = mcp.get_doc(a.issue)
    if not (a.json or a.rendered):
        print(to_xml(doc, a.pointer))
        return
    node = resolve(doc, a.pointer)[2] if a.pointer else doc
    print(render(node) if a.rendered else json.dumps(node, indent=2, ensure_ascii=False))


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


def cmd_login(mcp, a):
    login(force=a.force)


# ----------------------------------------------------------- status workflow


# A card's transitions endpoint answers for that card's CURRENT status only, so no
# single card can reveal a chain longer than one hop. The graph is sampled instead:
# for each status not yet known, JQL finds one card of the same project and issue
# type sitting in it, and that card's transitions become the edges leaving that
# status. Every call is a read, and the result is cached per `project:issuetype`.


def _read_flow():
    if not os.path.exists(FLOW_PATH):
        return {}
    with open(FLOW_PATH) as f:
        return json.load(f)


def _write_flow(flow):
    os.makedirs(CONFIG_DIR, mode=0o700, exist_ok=True)
    with open(FLOW_PATH, "w") as f:
        json.dump(flow, f, indent=2, ensure_ascii=False)


def _place(mcp, key):
    """(project key, issue type name, current status name) for one card."""
    issue = mcp.call(
        "getJiraIssue",
        {"issueIdOrKey": key, "fields": ["status", "project", "issuetype"], "responseContentFormat": "adf"},
    )
    fields = issue.get("fields") or {}
    absent = [n for n in ("project", "issuetype", "status") if not isinstance(fields.get(n), dict)]
    if absent:
        raise Fail(f"{key} returned no {', '.join(absent)} — the card cannot be placed in a workflow")
    return fields["project"]["key"], fields["issuetype"]["name"], fields["status"]["name"]


def _exits(mcp, key):
    """Transitions leaving one card's current status, keyed by destination status."""
    res = mcp.call("getTransitionsForJiraIssue", {"issueIdOrKey": key})
    return {
        t["to"]["name"]: {
            "id": t["id"],
            "name": t["name"],
            "conditional": bool(t.get("isConditional")),
            "screen": bool(t.get("hasScreen")),
        }
        for t in (res.get("transitions") or [])
    }


def _sample(mcp, project, itype, status):
    """One card of this project and issue type sitting in `status`, or None."""
    jql = f'project = "{project}" AND issuetype = "{itype}" AND status = "{status}" ORDER BY updated DESC'
    res = mcp.call(
        "searchJiraIssuesUsingJql",
        {"jql": jql, "fields": ["status"], "maxResults": 1, "responseContentFormat": "adf"},
    )
    issues = (res.get("issues") if isinstance(res, dict) else res) or []
    return issues[0].get("key") if issues else None


def _graph(mcp, key, refresh=False):
    """Sample and cache the status graph around one card. `None` edges = unexplored."""
    project, itype, status = _place(mcp, key)
    slot = f"{project}:{itype}"
    flow = _read_flow()
    edges = {} if refresh else dict((flow.get(slot) or {}).get("edges") or {})
    # The card itself is authoritative for its own status, so re-read that row even
    # when cached; every other row is a sample and is kept.
    frontier, seen = [status], set()
    edges.pop(status, None)
    while frontier:
        s = frontier.pop(0)
        if s in seen:
            continue
        seen.add(s)
        if s not in edges:
            src = key if s == status else _sample(mcp, project, itype, s)
            edges[s] = (
                None
                if src is None
                else [dict(to=to, **tr) for to, tr in _exits(mcp, src).items()]
            )
        frontier += [e["to"] for e in edges[s] or []]
    flow[slot] = {"edges": edges}
    _write_flow(flow)
    return project, itype, status, edges


def _match_status(name, known):
    exact = [s for s in known if s.lower() == name.lower()]
    if exact:
        return exact[0]
    near = [s for s in known if name.lower() in s.lower()]
    if len(near) == 1:
        return near[0]
    if near:
        raise Fail(f"{name!r}가 {', '.join(sorted(near))} 여러 상태에 걸립니다 — 이름을 정확히 쓰세요")
    raise Fail(f"이 워크플로에 {name!r} 상태가 없습니다 — 아는 상태: {', '.join(sorted(known))}")


def _chain(edges, start, target):
    """Shortest status chain from `start` to `target`, inclusive, or None."""
    prev = {start: None}
    frontier = [start]
    while frontier:
        s = frontier.pop(0)
        if s == target:
            path = []
            while s is not None:
                path.append(s)
                s = prev[s]
            return path[::-1]
        for e in edges.get(s) or []:
            if e["to"] not in prev:
                prev[e["to"]] = s
                frontier.append(e["to"])
    return None


def _routes(edges, start):
    """Cheapest transition-id path from `start` to every status it can reach.

    A one-hop route is one id; a chain is every id in order. `edges` may hold a
    None row for a status no card was found in, and a status sitting only behind
    such a row is reachable in the real workflow yet has no path here — it is
    reported with no ids rather than left out, because absent evidence of a route
    is not evidence that none exists.
    """
    routes, frontier = {}, [(start, [])]
    while frontier:
        s, path = frontier.pop(0)
        for e in edges.get(s) or []:
            if e["to"] not in routes:
                routes[e["to"]] = path + [e["id"]]
                frontier.append((e["to"], routes[e["to"]]))
    return routes


def _arrow(ids):
    """`--31-->` for one hop, `==31==111==>` for a chain, `~~???~~>` for no route."""
    if not ids:
        return "~~???~~>"
    return f"--{ids[0]}-->" if len(ids) == 1 else "==" + "==".join(ids) + "==>"


def cmd_flow(mcp, a):
    project, itype, status, edges = _graph(mcp, a.issue, refresh=a.refresh)
    routes = _routes(edges, status)
    known = set(edges) | {e["to"] for outs in edges.values() for e in (outs or [])}
    # A workflow's self-loop (To Do → To Do, id 151 here) is a real transition, and
    # listing it says nothing: the card is already there.
    elsewhere = (known | set(routes)) - {status}
    reachable = sorted(elsewhere, key=lambda s: (len(routes.get(s, [])) or 99, s))
    print(f"{a.issue}  {project}:{itype}\n")
    print(f"Current: {status}")
    print("You can:")
    for s in reachable:
        print(f"    {_arrow(routes.get(s))} {s}")
    print("and you may have future transitions.")


def cmd_move(mcp, a):
    project, itype, status, edges = _graph(mcp, a.issue)
    target = _match_status(a.target, edges)
    if status == target:
        print(f"{a.issue} 는 이미 {target} 입니다 — 전이할 것이 없습니다.")
        return
    path = _chain(edges, status, target)
    if path is None:
        raise Fail(f"{status} → {target} 경로가 없습니다 — `jira flow -i {a.issue}` 로 그래프를 보세요")
    ids = _routes(edges, status).get(target) or []
    print(f"{status}  {_arrow(ids)}  {target}")
    for n, dst in enumerate(path[1:], 1):
        # The card's own transitions are re-read at each hop: the sampled graph says
        # where to go, and only the live list says whether THIS card may go there.
        live = _exits(mcp, a.issue)
        tr = live.get(dst)
        if tr is None:
            raise Fail(
                f"{a.issue} 는 지금 {dst} 로 갈 수 없습니다 (가능: {', '.join(sorted(live)) or '없음'})\n"
                f"  {n - 1}홉까지만 적용되었습니다 — 남은 구간은 다시 실행하세요."
            )
        mcp.call("transitionJiraIssue", {"issueIdOrKey": a.issue, "transition": {"id": tr["id"]}})
        print(f"✓ {n}/{len(path) - 1} {dst}  [{tr['id']} {tr['name']}]")
    now = _place(mcp, a.issue)[2]
    if now != target:
        raise Fail(f"{target} 를 기대했지만 카드는 {now} 입니다 — 워크플로 post function이 상태를 옮겼습니다")
    print(f"\n{a.issue} 현재 상태: {now}")


# ------------------------------------------------------------------ self-check


FIXTURE = os.path.join(os.path.dirname(os.path.realpath(__file__)), "fixture.adf.json")


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

    print("\n✓ selfcheck 통과")


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


# ------------------------------------------------------------------------ main


TOP_HELP = """\
WORKFLOW — every edit is staged first, then flushed as one write per card.

    1. jira show  -i KEY                 read the card's ADF, find the node
    2. jira edit queue -i KEY '<sel>' …  stage one edit (repeatable, any card)
    3. jira edit status                  review what is staged (no network)
    4. jira edit apply                   pre-flight every card, then write

READING — no card is needed to start; these never write.

    jira search 'project = PROJ AND status = "In Progress"'   JQL, one row per card
    jira info -i KEY                     status, assignee, parent, labels
    jira show -i KEY                     the body as the selector's XML view
    jira show -i KEY --rendered          the body as plain text, cheapest to read

STATUS — the workflow graph is sampled from real cards, then walked for real.

    jira flow -i KEY                     every status this card can reach, and how
    jira move -i KEY 'Dev Done'          walk that chain, one transition per hop

SELECTORS — the ADF tree is queried with real CSS. The element name is the node's
`type`, its `attrs` are attributes, and `mark` holds the marks space-separated.

    heading[level="2"]                   every H2
    tableRow:nth-child(2) tableCell:nth-child(3)   row 2, column 3
    text[mark~="strong"]                 bold runs (~= matches one of many marks)
    panel[panelType="warning"] paragraph paragraphs inside a warning panel
    --jq 'select(.type=="media")'        escape hatch when CSS cannot express it

    `jira types` lists every node type name. `jira types panel` prints its attrs.

STDIN — --before/--after/--append and the default replace read ONE ADF node as
JSON from stdin. --text and --delete take no stdin.

    Copy the shape from the card itself: `jira show -i KEY --pointer /content/3`.

SAFETY
    A selector matching 2+ nodes aborts. Pass --all to mean it.
    apply dry-runs every queued card and writes nothing when any check fails.
    A node changed since queueing aborts and prints a token. Re-run with that
    --token=<hex> to accept the new state. The token is a hash of the drift, so
    a further change invalidates it.
    The finished document is validated against the ADF schema before the write.

EXAMPLES
    jira edit queue -i PROJ-1 'heading[level="2"]' --text '새 제목'
    jira edit queue -i PROJ-1 'table' --delete
    echo '{"type":"paragraph","content":[{"type":"text","text":"hi"}]}' \\
      | jira edit queue -i PROJ-1 'heading:first-child' --after
    jira edit apply
"""

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


FLOW_HELP = """\
Jira only tells a card which transitions leave its CURRENT status, so a two-hop move
like To Do → In Progress → Dev Done cannot be read off the card. `flow` samples the
whole graph instead: for every status it has not seen, JQL finds one card of the same
project and issue type sitting there, and that card's transitions become the edges
leaving that status. Every call is a read, and the graph is cached per
`project:issuetype` in ~/.config/jira-cli/workflow.json. Pass --refresh to re-sample.

`flow` lists every status the card can reach and how, one line each:

    Current: To Do
    You can:
        --31--> In Progress          one transition, id 31
        ==31==111==> Dev Done        a chain, every id in order
        ~~???~~> In QA               reachable in Jira, no route known here
    and you may have future transitions.

`~~???~~>` and the closing line say the same thing: this graph is a sample, not the
workflow definition. A status holding no card cannot be sampled, so anything sitting
behind it has no route here even though Jira allows one.

`move` walks the chain for real and re-reads the card's own transitions before each
hop — the sampled graph says where to go, and only the live list says whether THIS
card may go there. A refused hop stops the walk and names how far it got; the earlier
hops stay applied, because Jira has no transaction over a status change.

EXAMPLES
    jira flow -i PROJ-1                    every reachable status, and the route
    jira flow -i PROJ-1 --refresh          re-sample, ignoring the cache
    jira move -i PROJ-1 'Dev Done'         run the chain to Dev Done
"""


def main():
    fmt = argparse.RawDescriptionHelpFormatter
    p = argparse.ArgumentParser(
        prog="jira", description=__doc__.splitlines()[0], epilog=TOP_HELP, formatter_class=fmt
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    ed = sub.add_parser("edit", help="stage and flush ADF edits", epilog=TOP_HELP, formatter_class=fmt)
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

    sh = sub.add_parser("show", help="print a card's ADF as the selector's XML view", epilog=SHOW_HELP, formatter_class=fmt)
    sh.add_argument("-i", "--issue", required=True, metavar="KEY")
    sh.add_argument("--pointer", metavar="PTR", help="print only this JSON pointer, e.g. /content/3")
    view = sh.add_mutually_exclusive_group()
    view.add_argument("--xml", action="store_true", help="the selector's XML view (the default; named so it can be explicit)")
    view.add_argument("--json", action="store_true", help="print raw ADF JSON instead — the shape stdin wants")
    view.add_argument("--rendered", action="store_true", help="print a lossy plain-text reading view, no pointers")
    sh.set_defaults(fn=cmd_show)

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

    fl = sub.add_parser(
        "flow", help="list every status this card can reach, and the route to each",
        epilog=FLOW_HELP, formatter_class=fmt,
    )
    fl.add_argument("-i", "--issue", required=True, metavar="KEY")
    fl.add_argument("--refresh", action="store_true", help="re-sample the graph, ignoring the cache")
    fl.set_defaults(fn=cmd_flow)

    mv = sub.add_parser(
        "move", help="walk the chain to a target status, one real transition per hop",
        epilog=FLOW_HELP, formatter_class=fmt,
    )
    mv.add_argument("-i", "--issue", required=True, metavar="KEY")
    mv.add_argument("target", help="the status to end in, e.g. 'Dev Done'")
    mv.set_defaults(fn=cmd_move)

    ty = sub.add_parser("types", help="list ADF node types, or one type's attrs")
    ty.add_argument("type", nargs="?", help="a node type name, e.g. panel")
    ty.set_defaults(fn=cmd_types)

    md = sub.add_parser("media", help="media node tools").add_subparsers(dest="sub", required=True)
    ml = md.add_parser("ls", help="list media nodes already on the card")
    ml.add_argument("-i", "--issue", required=True, metavar="KEY")
    ml.set_defaults(fn=cmd_media)

    sc = sub.add_parser("schema", help="ADF schema tools").add_subparsers(dest="sub", required=True)
    sc.add_parser("update", help="refresh the local ADF schema").set_defaults(fn=cmd_schema_update)

    lg = sub.add_parser("login", help="authorize this machine")
    lg.add_argument("--force", action="store_true", help="register a fresh client too")
    lg.set_defaults(fn=cmd_login)

    sub.add_parser("selfcheck", help="run the offline assertions").set_defaults(fn=cmd_selfcheck)

    a = p.parse_args()
    if getattr(a, "fn", None) is cmd_queue and not (a.selector or a.jq):
        p.error("give a CSS selector or --jq — `jira edit queue --help` has examples")
    if getattr(a, "fn", None) is cmd_search and not 1 <= a.max <= 100:
        p.error(f"-n must be 1-100, got {a.max} — the MCP search caps a page at 100")
    a.fn(MCP(), a)


if __name__ == "__main__":
    main()
