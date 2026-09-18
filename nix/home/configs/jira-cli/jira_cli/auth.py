"""HTTP helpers, credentials, DCR + PKCE login, token refresh, and the `login` command."""

import base64
import hashlib
import http.server
import json
import os
import secrets
import socketserver
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

MCP_URL = "https://mcp.atlassian.com/v1/mcp"
REGISTER_URL = "https://cf.mcp.atlassian.com/v1/register"
AUTHORIZE_URL = "https://mcp.atlassian.com/v1/authorize"
TOKEN_URL = "https://cf.mcp.atlassian.com/v1/token"
PROTOCOL_VERSION = "2025-06-18"
SCOPES = "read:jira-work write:jira-work offline_access"
CALLBACK_PORT = 8765

CONFIG_DIR = os.path.expanduser("~/.config/jira-cli")
CRED_PATH = os.path.join(CONFIG_DIR, "credentials.json")

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


def cmd_login(mcp, a):
    login(force=a.force)


def register(sub, fmt):
    lg = sub.add_parser("login", help="authorize this machine")
    lg.add_argument("--force", action="store_true", help="register a fresh client too")
    lg.set_defaults(fn=cmd_login)
