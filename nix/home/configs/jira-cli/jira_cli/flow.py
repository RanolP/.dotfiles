"""The status-workflow domain: the sampled transition graph, `flow` and `move`."""

import json
import os

from jira_cli.auth import CONFIG_DIR, Fail

FLOW_PATH = os.path.join(CONFIG_DIR, "workflow.json")


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


def register(sub, fmt):
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
