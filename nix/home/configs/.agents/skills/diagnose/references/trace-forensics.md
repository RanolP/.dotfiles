# Trace forensics

Use this when the capture already exists (a `.cpuprofile`, a Chrome trace `.json` or `.json.gz`, a `.heapsnapshot`, a `sample` or `spindump` text). The artifact is a fixed dataset: query it, and re-capture only to get a paired before/after.

## 1. Reach the queryable shape before reading

Load the artifact into `duckdb` with one row per sample, event or node, then read query results rather than the raw file. A large artifact goes to a worker that returns only the reduced finding. `read_json` reads `.gz` directly; raise `maximum_object_size` (up to about 1e9 -- 4e9 fails with "Invalid argument") because each of these files is a single JSON object. Put `.bail on` first so a failed load stops the script instead of cascading.

**CPU profile** (`.cpuprofile` from `node --cpu-prof` or the DevTools profiler) -- self-time by frame:

```sql
.bail on
CREATE TABLE prof AS SELECT * FROM read_json('<path>.cpuprofile', maximum_object_size = 1000000000);
CREATE TABLE nodes AS
  SELECT n.id, n.callFrame.functionName AS fn, n.callFrame.url AS url, n.callFrame.lineNumber + 1 AS line, n.children
  FROM (SELECT unnest(nodes) AS n FROM prof);
CREATE TABLE samples AS SELECT unnest(samples) AS node_id, unnest(timeDeltas) AS dt_us FROM prof;
SELECT fn, url, line, round(sum(dt_us) / 1000, 1) AS self_ms, count(*) AS n_samples
FROM samples JOIN nodes ON nodes.id = samples.node_id
GROUP BY ALL ORDER BY self_ms DESC LIMIT 20;
```

Walk up from the top frame through `nodes.children` to see which caller reaches it.

**Chrome trace** (`{"traceEvents": [...]}`; a DevTools export may be a bare array, then `unnest` the top level instead) -- time by event name:

```sql
.bail on
CREATE TABLE ev AS SELECT unnest(traceEvents, recursive := false) AS e
  FROM read_json('<path>.json', maximum_object_size = 1000000000);
SELECT e.name, e.cat, count(*) AS n, round(sum(e.dur) / 1000, 1) AS total_ms, round(max(e.dur) / 1000, 1) AS max_ms
FROM ev WHERE e.ph = 'X' GROUP BY ALL ORDER BY total_ms DESC LIMIT 20;
```

**Heap snapshot** (`.heapsnapshot`): `nodes` and `edges` are flat integer arrays whose stride is the length of `snapshot.meta.node_fields` / `edge_fields`, and names index into `strings`. Reshape both, attach each edge to its owner by the running sum of `edge_count`, then count by class and walk retainers up to the root (node 0):

```sql
.bail on
CREATE TABLE snap AS SELECT * FROM read_json('<path>.heapsnapshot', maximum_object_size = 1000000000);
CREATE TABLE hn AS
  WITH m AS (SELECT len(snapshot.meta.node_fields) AS nf, snapshot.meta.node_types[1]::VARCHAR[] AS types, nodes AS a, strings AS s FROM snap),
  r AS (SELECT i, types[a[i*nf + 1] + 1] AS type, s[a[i*nf + 2] + 1] AS name, a[i*nf + 4] AS self_size, a[i*nf + 5] AS edge_count
        FROM m, range(len(a) // nf) t(i))
  SELECT *, sum(edge_count) OVER (ORDER BY i) - edge_count AS first_edge FROM r;
CREATE TABLE he AS
  WITH m AS (SELECT len(snapshot.meta.edge_fields) AS ef, len(snapshot.meta.node_fields) AS nf, snapshot.meta.edge_types[1]::VARCHAR[] AS types, edges AS a, strings AS s FROM snap)
  SELECT j, types[a[j*ef + 1] + 1] AS type,
         CASE WHEN types[a[j*ef + 1] + 1] IN ('element', 'hidden') THEN a[j*ef + 2]::VARCHAR ELSE s[a[j*ef + 2] + 1] END AS name,
         a[j*ef + 3] // nf AS to_node
  FROM m, range(len(a) // ef) t(j);
CREATE TABLE edge AS SELECT hn.i AS from_node, he.* FROM he JOIN hn ON he.j >= hn.first_edge AND he.j < hn.first_edge + hn.edge_count;
SELECT type, left(name, 60) AS name, count(*) AS n, sum(self_size) AS bytes FROM hn GROUP BY ALL ORDER BY bytes DESC LIMIT 20;
WITH RECURSIVE up(node, depth, path) AS (
  SELECT (SELECT min(i) FROM hn WHERE name = '<SuspectClass>' AND type = 'object'), 0, ''
  UNION ALL
  SELECT e.from_node, depth + 1, hn.name || '.' || e.name || ' <- ' || path
  FROM up JOIN edge e ON e.to_node = up.node AND e.type <> 'weak' JOIN hn ON hn.i = e.from_node
  WHERE depth < 8 AND up.node <> 0
)
SELECT depth, path FROM up WHERE node = 0 ORDER BY depth LIMIT 3;
```

The `node_types[1]` / `edge_types[1]` casts are needed because those meta arrays mix a list with plain strings, so DuckDB reads them as JSON. Raise `depth < 8` when no path reaches the root.

**`sample` / `spindump` text**: find the thread whose stack stays on-CPU across samples, or the blocked thread and its wait reason (a lock, `mach_msg`, a semaphore); `rg` on the call-graph lines is enough at that size.

## 2. Narrow to the cause

Take the frames holding the most self-time and walk the call tree to the hot path; for a leak, the class whose count grows and the retainer chain that holds it; for a hang, the stuck thread and what it waits on.

## 3. Confirm with a paired capture

Capture the same scenario before and after the change and diff the reduced tables. For heap snapshots, build `hn` from each file into `hn_before` / `hn_after` and compare counts:

```sql
SELECT type, left(name, 60) AS name, coalesce(a.n, 0) - coalesce(b.n, 0) AS delta_n, coalesce(a.bytes, 0) - coalesce(b.bytes, 0) AS delta_bytes
FROM (SELECT type, name, count(*) n, sum(self_size) bytes FROM hn_before GROUP BY ALL) b
FULL JOIN (SELECT type, name, count(*) n, sum(self_size) bytes FROM hn_after GROUP BY ALL) a USING (type, name)
ORDER BY abs(delta_bytes) DESC LIMIT 20;
```

With no pair, label the finding "the strongest hypothesis this artifact supports" rather than a confirmed cause.

## 4. Attribute to source

Report every finding as `file:symbol:line` through the artifact's own symbols. A minified or unsymbolicated frame is a location still to resolve: map it through the source map (`.map` beside the bundle) or the dSYM (`atos -o <dSYM> -l <load addr> <addr>`), or state plainly that the artifact carries no symbols and name what would supply them.

Reply with the artifact and its format, the reduced finding, the source location, the artifact paths, and whether a paired capture confirmed it.
