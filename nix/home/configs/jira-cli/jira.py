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

from jira_cli import adf, auth, cards, edit, flow, selfcheck
from jira_cli.mcp import MCP

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
    jira comments -i KEY                 every comment, oldest first, as plain text
    jira comments -i KEY --add --text …  post one comment right away (or an ADF doc on stdin)

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


def main():
    fmt = argparse.RawDescriptionHelpFormatter
    p = argparse.ArgumentParser(
        prog="jira", description=__doc__.splitlines()[0], epilog=TOP_HELP, formatter_class=fmt
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    # Registration order is the order the usage line lists the commands in.
    edit.register(sub, fmt, TOP_HELP)
    adf.register(sub, fmt)
    cards.register(sub, fmt)
    flow.register(sub, fmt)
    adf.register_tools(sub, fmt)
    auth.register(sub, fmt)
    selfcheck.register(sub, fmt)

    a = p.parse_args()
    if getattr(a, "fn", None) is edit.cmd_queue and not (a.selector or a.jq):
        p.error("give a CSS selector or --jq — `jira edit queue --help` has examples")
    if getattr(a, "fn", None) is cards.cmd_search and not 1 <= a.max <= 100:
        p.error(f"-n must be 1-100, got {a.max} — the MCP search caps a page at 100")
    a.fn(MCP(), a)


if __name__ == "__main__":
    main()
