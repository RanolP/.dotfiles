"""MCP JSON-RPC transport: session, cloud id, and the card read/write calls."""

import json
import os

from jira_cli.auth import (
    MCP_URL,
    PROTOCOL_VERSION,
    Fail,
    _access_token,
    _http,
    _read_creds,
    _refresh,
    _write_creds,
)

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

    def get_comments(self, key):
        """The comment field carries the whole thread inline, so one read is enough."""
        issue = self.call(
            "getJiraIssue",
            {"issueIdOrKey": key, "fields": ["comment"], "responseContentFormat": "adf"},
        )
        return (issue.get("fields") or {}).get("comment") or {}

    def put_doc(self, key, doc):
        return self.call(
            "editJiraIssue",
            {"issueIdOrKey": key, "fields": {"description": doc}, "contentFormat": "adf"},
        )

    def put_comment(self, key, doc, comment_id=None):
        args = {
            "issueIdOrKey": key,
            "commentBody": json.dumps(doc, ensure_ascii=False),
            "contentFormat": "adf",
            "responseContentFormat": "adf",
        }
        if comment_id:
            args["commentId"] = str(comment_id)
        return self.call("addCommentToJiraIssue", args)


def _unwrap(body):
    """MCP answers either plain JSON or an SSE stream; take the first data frame."""
    for line in body.splitlines():
        if line.startswith("data: "):
            return json.loads(line[6:])
    return json.loads(body) if body.strip() else {}
