#!/usr/bin/env node
// Port of the old bash+jq statusline.sh, using only node (already on PATH via
// mise) so this runs the same on Windows/macOS/Linux without a bash/jq
// runtime dependency. One deliberate simplification: the bash version walked
// the parent-process tree via `ps`/`stty` to find the real terminal width
// because its own stdout isn't a tty (Claude Code pipes it). That trick is
// unix-only (ps/stty/tty don't exist on native Windows), so this version
// just falls back to $COLUMNS or 80 -- good enough for a status line.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const G = "\x1b[32m";
const Y = "\x1b[33m";
const O = "\x1b[38;5;208m";
const R = "\x1b[31m";
const C = "\x1b[36m";
const W = "\x1b[97m";
const GR = "\x1b[90m";
const RS = "\x1b[0m";

const FOLDER_ICON = Buffer.from([0xef, 0x81, 0xbb]).toString("utf8"); // nf-fa-folder
const BRANCH_ICON = Buffer.from([0xee, 0x82, 0xa0]).toString("utf8"); // nf-pl-branch
const RL_ICON = Buffer.from([0xf3, 0xb0, 0x91, 0x90]).toString("utf8");

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function get(obj, pathStr, fallback) {
  const parts = pathStr.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return fallback;
    cur = cur[p];
  }
  return cur === undefined || cur === null ? fallback : cur;
}

function columns() {
  if (process.stdout.isTTY && process.stdout.columns) return process.stdout.columns;
  const envCols = parseInt(process.env.COLUMNS || "", 10);
  if (Number.isFinite(envCols) && envCols > 0) return envCols;
  return 80;
}

function run(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim();
  } catch {
    return null;
  }
}

function gitInfo(dir, sessionId) {
  const cacheFile = path.join(os.tmpdir(), `claude-sl-git-${sessionId}.json`);
  let stale = true;
  try {
    const stat = fs.statSync(cacheFile);
    stale = Date.now() - stat.mtimeMs > 5000;
  } catch {
    stale = true;
  }

  if (stale) {
    let info = { branch: "", staged: 0, modified: 0 };
    if (run(["rev-parse", "--git-dir"], dir) !== null) {
      const branch = run(["branch", "--show-current"], dir) || "";
      const staged = (run(["diff", "--cached", "--numstat"], dir) || "")
        .split("\n")
        .filter(Boolean).length;
      const modified = (run(["diff", "--numstat"], dir) || "")
        .split("\n")
        .filter(Boolean).length;
      info = { branch, staged, modified };
    }
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(info));
    } catch {
      // best-effort cache; ignore write failures
    }
    return info;
  }

  try {
    return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  } catch {
    return { branch: "", staged: 0, modified: 0 };
  }
}

function main() {
  const input = JSON.parse(readStdin() || "{}");

  const MODEL = get(input, "model.display_name", "");
  const EFFORT = get(input, "effort.level", "");
  const THINKING = get(input, "thinking.enabled", false);
  const DIR = get(input, "workspace.current_dir", ".");
  const SESSION_ID = get(input, "session_id", "unknown");
  const PCT = Math.trunc(Number(get(input, "context_window.used_percentage", 0)) || 0);
  const COST = Number(get(input, "cost.total_cost_usd", 0)) || 0;
  const DURATION_MS = Number(get(input, "cost.total_duration_ms", 0)) || 0;
  const LINES_ADDED = Number(get(input, "cost.total_lines_added", 0)) || 0;
  const LINES_REMOVED = Number(get(input, "cost.total_lines_removed", 0)) || 0;
  const FIVE_H = get(input, "rate_limits.five_hour.used_percentage", "");
  const FIVE_H_RESET = get(input, "rate_limits.five_hour.resets_at", "");
  const WEEK = get(input, "rate_limits.seven_day.used_percentage", "");
  const WEEK_RESET = get(input, "rate_limits.seven_day.resets_at", "");
  const PR_NUM = get(input, "pr.number", "");
  const PR_STATE = get(input, "pr.review_state", "");

  // Logged-in account email (not in statusline input; read from the CLI config).
  // `ccc <profile>` runs claude under CLAUDE_CONFIG_DIR=~/.claude-<profile>, which
  // holds that profile's own .claude.json + auth. Read it so the active account
  // shows, not the default ~/.claude.json profile.
  const claudeJsonPath = path.join(
    process.env.CLAUDE_CONFIG_DIR || os.homedir(),
    ".claude.json"
  );
  let EMAIL = "";
  try {
    const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
    EMAIL = get(claudeJson, "oauthAccount.emailAddress", "");
  } catch {
    EMAIL = "";
  }

  const { branch: GIT_BR, staged: GIT_ST, modified: GIT_MD } = gitInfo(DIR, SESSION_ID);

  const COLS = columns();

  // ── LINE 1 ─────────────────────────────────────────────────────────────
  const FOLDER = DIR.split(/[\\/]/).filter(Boolean).pop() || DIR;

  let L1L = "";
  let L1L_W = 0;
  if (EMAIL) {
    L1L += `${W}${EMAIL}${RS} in `;
    L1L_W += EMAIL.length + 4;
  }
  L1L += `${C}${FOLDER_ICON} ${FOLDER}${RS}`;
  L1L_W += 2 + FOLDER.length;

  if (GIT_BR) {
    L1L += ` on ${BRANCH_ICON} ${GIT_BR}`;
    L1L_W += 6 + GIT_BR.length;
    if (GIT_ST > 0) {
      L1L += ` ${G}+${GIT_ST}${RS}`;
      L1L_W += 2 + String(GIT_ST).length;
    }
    if (GIT_MD > 0) {
      L1L += ` ${Y}-${GIT_MD}${RS}`;
      L1L_W += 2 + String(GIT_MD).length;
    }
  }

  if (PR_NUM) {
    let PC;
    switch (PR_STATE) {
      case "approved": PC = G; break;
      case "pending": PC = Y; break;
      case "changes_requested": PC = R; break;
      case "draft": PC = GR; break;
      default: PC = W;
    }
    const PR_TXT = PR_STATE ? `#${PR_NUM} ${PR_STATE}` : `#${PR_NUM}`;
    L1L += ` ${PC}${PR_TXT}${RS}`;
    L1L_W += 1 + PR_TXT.length;
  }

  let L1R = `using ${W}${MODEL}${RS}`;
  let L1R_W = 6 + MODEL.length;
  if (EFFORT) {
    L1R += ` ${GR}${EFFORT}${RS}`;
    L1R_W += 1 + EFFORT.length;
  }
  if (THINKING === true || THINKING === "true") {
    L1R += " \u{1F9E0}";
    L1R_W += 3;
  }

  const GAP1 = Math.max(1, COLS - L1L_W - L1R_W);
  console.log(`${L1L}${" ".repeat(GAP1)}${L1R}`);

  // ── LINE 2 ─────────────────────────────────────────────────────────────
  let BAR_C;
  if (PCT >= 80) BAR_C = R;
  else if (PCT >= 60) BAR_C = O;
  else if (PCT >= 40) BAR_C = Y;
  else BAR_C = G;

  const COST_FMT = `$${COST.toFixed(2)}`;

  const L2L = `${GR}used ${RS}${Y}${COST_FMT}${RS}${GR} with ${RS}${BAR_C}${PCT}%${RS}${GR} contexts${RS}`;
  const L2L_W = 5 + COST_FMT.length + 6 + String(PCT).length + 10;

  const DUR_SEC = Math.trunc(DURATION_MS / 1000);
  const MINS = Math.trunc(DUR_SEC / 60);
  const SECS = DUR_SEC % 60;
  const DUR = `${MINS}m ${SECS}s`;
  const ADDED_STR = `+${LINES_ADDED}`;
  const REMOVED_STR = `-${LINES_REMOVED}`;
  const L2R = `${G}${ADDED_STR}${RS} ${R}${REMOVED_STR}${RS} ${GR}${DUR}${RS}`;
  const L2R_W = ADDED_STR.length + 1 + REMOVED_STR.length + 1 + DUR.length;

  const GAP2 = Math.max(1, COLS - L2L_W - L2R_W);
  console.log(`${L2L}${" ".repeat(GAP2)}${L2R}`);

  // ── LINE 3 ─────────────────────────────────────────────────────────────
  let FH_STR;
  if (FIVE_H !== "" && FIVE_H !== null && FIVE_H !== undefined) {
    const FH = Math.round(Number(FIVE_H));
    let TIME_UNTIL = "";
    if (FIVE_H_RESET) {
      const DIFF_SEC = Number(FIVE_H_RESET) - Math.floor(Date.now() / 1000);
      if (DIFF_SEC <= 0) {
        TIME_UNTIL = "now";
      } else if (DIFF_SEC < 3600) {
        TIME_UNTIL = `${Math.trunc(DIFF_SEC / 60)}m`;
      } else {
        const DIFF_H = Math.trunc(DIFF_SEC / 3600);
        const DIFF_M = Math.trunc((DIFF_SEC % 3600) / 60);
        TIME_UNTIL = DIFF_M > 0 ? `${DIFF_H}h${DIFF_M}m` : `${DIFF_H}h`;
      }
    }
    FH_STR = `${GR}5h ${RS}${W}${FH}%${RS}${GR} ${RL_ICON}${RS}`;
    if (TIME_UNTIL) FH_STR += `${GR} in ${RS}${W}${TIME_UNTIL}${RS}`;
  } else {
    FH_STR = `${GR}5h ${RS}${W}unknown${RS}`;
  }

  let WK_STR;
  if (WEEK !== "" && WEEK !== null && WEEK !== undefined) {
    const WK = Math.round(Number(WEEK));
    let WEEK_RESET_FMT = "";
    if (WEEK_RESET) {
      const d = new Date(Number(WEEK_RESET) * 1000);
      const dow = d.toLocaleDateString("en-US", { weekday: "short" });
      const mm = String(d.getMinutes()).padStart(2, "0");
      WEEK_RESET_FMT = `${dow} ${d.getHours()}:${mm}`;
    }
    WK_STR = `${GR}weekly ${RS}${W}${WK}%${RS}${GR} ${RL_ICON}${RS}`;
    if (WEEK_RESET_FMT) WK_STR += `${GR} at ${RS}${W}${WEEK_RESET_FMT}${RS}`;
  } else {
    WK_STR = `${GR}weekly ${RS}${W}unknown${RS}`;
  }

  console.log(`${FH_STR}${GR}  ${RS}${WK_STR}`);
}

main();
