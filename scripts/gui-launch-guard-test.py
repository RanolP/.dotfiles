#!/usr/bin/env python3
"""Semantics test for gui-launch-guard.py.

The guard denies launching a desktop GUI app from Bash (`open -a`, `open -b`,
`open <path>.app`, an `.app/Contents/MacOS/` binary, `electron <path>`,
`electron-forge start`) and hands the launch back as a `! <command>` line. It
passes the sanctioned background launch (`open -g`), every URL and non-.app
file, `agent-browser`/`agent-device`, a dev-server script, and anything it
cannot parse.

Usage: gui-launch-guard-test.py   (exit 0 when every case passes)
"""

import json
import os
import subprocess
import sys

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "nix", "home", "configs", "claude", "hooks", "gui-launch-guard.py")


def run(cmd):
    p = subprocess.run([sys.executable, HOOK], text=True, capture_output=True, timeout=30,
                       input=json.dumps({"tool_name": "Bash", "cwd": "/repo",
                                         "tool_input": {"command": cmd}}))
    if p.returncode != 0:
        return "error(%d): %s" % (p.returncode, p.stderr.strip()[-200:]), ""
    if not p.stdout.strip():
        return "passthrough", ""
    out = json.loads(p.stdout)["hookSpecificOutput"]
    return out["permissionDecision"], out["permissionDecisionReason"]


CASES = [
    # a desktop app reaching the user's screen from the agent's shell
    ("open -a", 'open -a "Visual Studio Code" .', "deny"),
    ("open -a no target", "open -a Slack", "deny"),
    ("open -na cluster", "open -na MyApp", "deny"),
    ("open -b", "open -b com.example.MyApp", "deny"),
    ("open .app path", "open dist/mac-arm64/MyApp.app", "deny"),
    ("open .app path slash", "open /Applications/Foo.app/", "deny"),
    ("open -W -n .app", "open -W -n ./out/App.app --args --debug", "deny"),
    ("open -a chrome without -g", 'open -a "Google Chrome" http://localhost:3000', "deny"),
    ("open -j is still a launch", "open -j -a Foo", "deny"),
    ("MacOS binary", "./dist/MyApp.app/Contents/MacOS/MyApp", "deny"),
    ("MacOS binary quoted space", '"/Applications/My App.app/Contents/MacOS/My App" --flag', "deny"),
    ("electron .", "electron .", "deny"),
    ("electron path", "electron ./dist/main.js", "deny"),
    ("electron bare", "electron", "deny"),
    ("npx electron", "npx electron .", "deny"),
    ("npx -y electron@30", "npx -y electron@30 .", "deny"),
    ("pnpm exec electron", "pnpm exec electron .", "deny"),
    ("pnpm --filter exec", "pnpm --filter desktop exec electron .", "deny"),
    ("npm exec electron", "npm exec electron -- .", "deny"),
    ("bunx electron", "bunx electron .", "deny"),
    ("bun x electron", "bun x electron .", "deny"),
    ("pnpm electron direct", "pnpm electron .", "deny"),
    ("yarn dlx", "yarn dlx electron .", "deny"),
    ("electron-forge start", "electron-forge start", "deny"),
    ("npx electron-forge start", "npx electron-forge start", "deny"),
    ("pnpm exec forge start", "pnpm exec electron-forge start -- --inspect", "deny"),
    # hidden behind an operator or a wrapper
    ("after &&", "pnpm build && open -a MyApp", "deny"),
    ("after ;", "cd app; electron .", "deny"),
    ("background &", "electron . &", "deny"),
    ("nohup", "nohup electron . > /tmp/log 2>&1 &", "deny"),
    ("env prefix", "ELECTRON_ENABLE_LOGGING=1 electron .", "deny"),
    ("env wrapper", "env DEBUG=1 open -a Foo", "deny"),
    ("subshell", "(cd app && electron .)", "deny"),

    # the screen rule's sanctioned background launch and other passes
    ("open -g", "open -g -a Foo", "passthrough"),
    ("open -gna chrome", 'open -gna "Google Chrome" --args --disable-backgrounding-occluded-windows '
     '--disable-renderer-backgrounding --disable-background-timer-throttling '
     '--remote-debugging-port=9222', "passthrough"),
    ("open --background", "open --background -a Foo", "passthrough"),
    ("open url", "open https://example.com", "passthrough"),
    ("open localhost", "open http://localhost:3000", "passthrough"),
    ("open html", "open report.html", "passthrough"),
    ("open pdf", "open ~/Downloads/x.pdf", "passthrough"),
    ("open png", "open shot.png", "passthrough"),
    ("open dir", "open .", "passthrough"),
    ("open -R reveal file", "open -R build/out.zip", "passthrough"),
    ("open --args .app value", "open report.html --args Foo.app", "passthrough"),
    ("headless chrome binary", '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" '
     '--headless=new --dump-dom https://example.com', "passthrough"),
    ("agent-browser", "agent-browser open http://localhost:3000", "passthrough"),
    ("agent-device", "agent-device open com.example.app --platform ios", "passthrough"),
    ("npm run dev", "npm run dev", "passthrough"),
    ("pnpm run dev", "pnpm run dev", "passthrough"),
    ("electron --version", "electron --version", "passthrough"),
    ("npx electron --version", "npx electron --version", "passthrough"),
    ("electron-forge make", "electron-forge make", "passthrough"),
    ("electron-builder", "npx electron-builder --mac", "passthrough"),
    ("pnpm add electron", "pnpm add -D electron", "passthrough"),
    ("ls .app", "ls /Applications/Foo.app/Contents/MacOS/", "passthrough"),
    ("codesign .app", "codesign -dv dist/MyApp.app", "passthrough"),
    ("plist read", "plutil -p /Applications/Foo.app/Contents/Info.plist", "passthrough"),

    # quoting traps and fail open
    ("quoted open -a", "echo 'open -a Foo'", "passthrough"),
    ("grep for electron .", "rg -n 'electron .' src", "passthrough"),
    ("quoted operator", "echo 'x && electron .'", "passthrough"),
    ("commit message", "git commit -m 'open -a Foo from the menu'", "passthrough"),
    ("unterminated quote", "open -a 'Foo", "passthrough"),
    ("empty", "", "passthrough"),
]


def main():
    failures = 0
    for name, cmd, want in CASES:
        got, _ = run(cmd)
        ok = got == want
        failures += not ok
        print("%s  %-28s want=%-11s got=%s" % ("ok  " if ok else "FAIL", name, want, got))

    # a deny is only useful when it hands the launch back as a `! <command>` line
    _, text = run("cd app && npx electron .")
    ok = "! npx electron ." in text
    failures += not ok
    print("%s  reason hands back `! npx electron .`" % ("ok  " if ok else "FAIL"))

    total = len(CASES) + 1
    print("%d/%d passed" % (total - failures, total))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
