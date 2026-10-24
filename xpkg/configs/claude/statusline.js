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
const R = "\x1b[31m";
const C = "\x1b[36m";
const W = "\x1b[97m";
const GR = "\x1b[90m";
const RS = "\x1b[0m";

const FOLDER_ICON = Buffer.from([0xef, 0x81, 0xbb]).toString("utf8"); // nf-fa-folder
const BRANCH_ICON = Buffer.from([0xee, 0x82, 0xa0]).toString("utf8"); // nf-pl-branch

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
  // Cost, context, duration, lines and the 5h/weekly limits moved to the dash
  // mod's pane, as in nix/home/configs/claude/statusline.sh.
}

main();
