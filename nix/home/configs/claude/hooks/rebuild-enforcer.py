#!/usr/bin/env python3
"""Multi-event hook: make "rebuild after dotfiles edits" a gate, not a hint.

The verdict comes from the machine, not from the session. "Is a rebuild
pending?" is answered by comparing the newest mtime under
~/.dotfiles/nix/home/configs/ against the mtime of the applied generation
symlink -- /nix/var/nix/profiles/system on darwin, the home-manager profile on
linux. Whoever ran the rebuild, in whichever shell, in whichever session, the
generation link moves and the pending state clears by itself.

The version this replaces tracked state per session instead, and both halves of
that broke in practice:

  - It cleared only when a `darwin-rebuild ... switch` came through the Bash
    tool. Policy is that the USER runs the rebuild in their own shell, so that
    PostToolUse never fired and the session stayed pending forever -- one Stop
    block listed four files edited many turns after the user had already
    rebuilt.
  - Its escape hatch read the last assistant message out of the transcript to
    see whether the command had already been handed over. At Stop time the
    turn's own message is not in the transcript yet, so the check always
    graded the PREVIOUS turn's message and blocked anyway.

Wired to two events in settings.json, dispatched on hook_event_name:

  PostToolUse Edit|Write : an edit under ~/.dotfiles/nix/home/configs/ injects
      an additionalContext reminder, once per (session, generation). (Plain
      PostToolUse stdout is debug-log-only; only the JSON hookSpecificOutput
      form reaches Claude.)
  Stop                   : while a rebuild is pending, block the stop ONCE per
      (session, generation), naming the unapplied files and the command to
      hand over -- but only in a session whose cwd is inside ~/.dotfiles,
      since the pending state is machine-wide and an unrelated project's
      session should not answer for it. stop_hook_active guards against loops;
      after the user rebuilds, the generation mtime changes and the next round
      of edits is free to block again.

The only state kept is "which generation did this session already speak up
for", one JSON file per session under $TMPDIR -- a dedupe marker, never the
source of truth. Fail-open everywhere: a bug here must never wedge a session,
and an unreadable generation link means silence, not a block.

Self-check: `python3 rebuild-enforcer.py --selftest`.
"""
import json
import os
import re
import sys
import tempfile

CONFIGS_DIR = os.path.expanduser("~/.dotfiles/nix/home/configs") + os.sep

# The Stop block only fires in a session working inside the dotfiles repo. The
# pending state is machine-wide (see the generation comparison below), so
# without this an edit made here would block the stop of an unrelated session
# in another project -- a repo whose work has nothing to do with the rebuild.
DOTFILES_DIR = os.path.expanduser("~/.dotfiles") + os.sep

# The apply command differs per host: darwin runs the whole system config,
# linux runs home-manager standalone. Naming the wrong one is not a cosmetic
# slip -- the Stop hook below refuses to let the session finish until the
# generation moves, so a darwin-only string strands every linux session.
DARWIN_REBUILD_CMD = "sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26"
LINUX_REBUILD_CMD = "home-manager switch --flake ~/.dotfiles/nix#ranolp-archwsl -b before-hm"

# The symlink each host's switch repoints. Its own mtime (never the target's --
# store paths carry a frozen epoch timestamp) is when the generation landed.
DARWIN_PROFILE = "/nix/var/nix/profiles/system"
LINUX_PROFILE = os.path.expanduser("~/.local/state/nix/profiles/home-manager")

IS_DARWIN = sys.platform == "darwin"
REBUILD_CMD = DARWIN_REBUILD_CMD if IS_DARWIN else LINUX_REBUILD_CMD
PROFILE_LINK = DARWIN_PROFILE if IS_DARWIN else LINUX_PROFILE


def generation_mtime(profile=None):
    """When the applied generation landed, or None when it cannot be read."""
    try:
        return os.lstat(profile or PROFILE_LINK).st_mtime
    except OSError:
        return None


def unapplied_files(since, root=None):
    """Config files edited after `since`, as paths relative to CONFIGS_DIR."""
    base = root or CONFIGS_DIR
    out = []
    for dirpath, _dirnames, filenames in os.walk(base):
        for name in filenames:
            full = os.path.join(dirpath, name)
            try:
                if os.stat(full).st_mtime > since:
                    out.append(os.path.relpath(full, base))
            except OSError:
                continue
    return sorted(out)


def state_path(session_id):
    slug = re.sub(r"[^A-Za-z0-9._-]", "_", session_id or "default")
    return os.path.join(tempfile.gettempdir(), f"claude-rebuild-state-{slug}.json")


def load_state(path):
    try:
        with open(path) as fh:
            st = json.load(fh)
        if isinstance(st, dict):
            return st
    except (OSError, ValueError):
        pass
    return {}


def save_state(path, st):
    try:
        with open(path, "w") as fh:
            json.dump(st, fh)
    except OSError:
        pass


def spoke_for(st, key, gen):
    """True when this session already said `key` for this exact generation."""
    return st.get(key) == gen


def is_config_edit(file_path):
    if not file_path:
        return False
    p = os.path.normpath(os.path.expanduser(file_path))
    return p.startswith(CONFIGS_DIR)


def in_dotfiles(cwd):
    """True when the session is working inside the dotfiles repo."""
    if not cwd:
        return False
    return (os.path.normpath(os.path.expanduser(cwd)) + os.sep).startswith(DOTFILES_DIR)


def emit(payload):
    print(json.dumps(payload))


def handle(data, profile=None, root=None):
    """Process one hook event; returns the JSON payload to emit, or None."""
    event = data.get("hook_event_name", "")
    gen = generation_mtime(profile)
    if gen is None:
        return None  # no ground truth available -- stay silent

    path = state_path(data.get("session_id", ""))
    st = load_state(path)

    if event == "PostToolUse":
        tool = data.get("tool_name", "")
        ti = data.get("tool_input", {}) or {}
        if tool not in ("Edit", "Write") or not is_config_edit(ti.get("file_path", "")):
            return None
        if spoke_for(st, "reminded", gen):
            return None
        st["reminded"] = gen
        save_state(path, st)
        return {"hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": (
                "nix config edited -- changes apply only after "
                f"`{REBUILD_CMD}`, which the user runs in their own shell. "
                "The Stop hook blocks finishing while the rebuild is "
                "outstanding."),
        }}

    if event == "Stop":
        if data.get("stop_hook_active"):
            return None
        if not in_dotfiles(data.get("cwd")):
            return None
        if spoke_for(st, "nagged", gen):
            return None
        files = unapplied_files(gen, root)
        if not files:
            return None
        st["nagged"] = gen
        save_state(path, st)
        return {"decision": "block", "reason": (
            f"Edited without applying: {', '.join(files)}. The user runs the "
            f"rebuild, not you: hand them `! {REBUILD_CMD}` to run in their "
            "own shell, say the change is pending until they run it, then "
            "stop.")}

    return None


def main():
    try:
        data = json.load(sys.stdin)
    except (OSError, ValueError):
        sys.exit(0)  # fail-open

    try:
        payload = handle(data)
    except Exception:
        sys.exit(0)  # fail-open
    if payload:
        emit(payload)
    sys.exit(0)


def selftest():
    sid = "selftest-rebuild-enforcer"
    spath = state_path(sid)
    for p in (spath,):
        try:
            os.remove(p)
        except OSError:
            pass

    tmp = tempfile.mkdtemp(prefix="rebuild-enforcer-selftest-")
    profile = os.path.join(tmp, "profile-link")
    root = os.path.join(tmp, "configs") + os.sep
    os.makedirs(os.path.join(root, "claude"))
    os.symlink("/nix/store/whatever", profile)

    def touch(rel, mtime):
        full = os.path.join(root, rel)
        with open(full, "w") as fh:
            fh.write("x")
        os.utime(full, (mtime, mtime))

    def set_generation(mtime):
        os.utime(profile, (mtime, mtime), follow_symlinks=False)

    def ev(**kw):
        return {"session_id": sid, "cwd": os.path.expanduser("~/.dotfiles"), **kw}

    cfg = CONFIGS_DIR + "claude/settings.json"

    # Applied generation is newer than every config file: nothing is pending.
    touch("claude/settings.json", 1000)
    set_generation(2000)
    assert unapplied_files(generation_mtime(profile), root) == []
    assert handle(ev(hook_event_name="Stop"), profile, root) is None

    # An edit after the generation is pending, and Stop blocks once.
    touch("claude/settings.json", 3000)
    assert unapplied_files(generation_mtime(profile), root) == ["claude/settings.json"]
    out = handle(ev(hook_event_name="Stop"), profile, root)
    assert out and out["decision"] == "block"
    assert "claude/settings.json" in out["reason"] and "! " in out["reason"]
    # Same generation, same session: silent from here on.
    assert handle(ev(hook_event_name="Stop"), profile, root) is None
    assert handle(ev(hook_event_name="Stop", stop_hook_active=True), profile, root) is None

    # A session outside the dotfiles repo never gets blocked, however pending
    # the machine is -- another project's work is not this repo's rebuild.
    os.remove(spath)
    assert handle(ev(hook_event_name="Stop", cwd="/tmp"), profile, root) is None
    assert handle(ev(hook_event_name="Stop", cwd=None), profile, root) is None
    assert in_dotfiles(os.path.expanduser("~/.dotfiles"))
    assert in_dotfiles(os.path.expanduser("~/.dotfiles/nix/home"))
    assert not in_dotfiles(os.path.expanduser("~/.dotfiles-other"))
    # Still pending for a session that IS in the repo: the gate is cwd, not state.
    assert handle(ev(hook_event_name="Stop"), profile, root)["decision"] == "block"

    # The user rebuilds in their own shell -- no tool call, but the generation
    # moves, so the state clears without the hook seeing anything.
    set_generation(4000)
    assert handle(ev(hook_event_name="Stop"), profile, root) is None
    # A fresh edit after that rebuild re-arms the block.
    touch("claude/.agents-AGENTS.md", 5000)
    assert handle(ev(hook_event_name="Stop"), profile, root)["decision"] == "block"

    # PostToolUse: config edits remind once per generation; other paths never.
    os.remove(spath)
    assert handle(ev(hook_event_name="PostToolUse", tool_name="Edit",
                     tool_input={"file_path": "/etc/hosts"}), profile, root) is None
    out = handle(ev(hook_event_name="PostToolUse", tool_name="Write",
                    tool_input={"file_path": cfg}), profile, root)
    assert out and "additionalContext" in out["hookSpecificOutput"]
    assert handle(ev(hook_event_name="PostToolUse", tool_name="Edit",
                     tool_input={"file_path": cfg}), profile, root) is None
    set_generation(6000)
    out = handle(ev(hook_event_name="PostToolUse", tool_name="Edit",
                    tool_input={"file_path": cfg}), profile, root)
    assert out and "additionalContext" in out["hookSpecificOutput"]

    # An unreadable generation link means silence, never a block.
    assert generation_mtime(os.path.join(tmp, "nope")) is None
    assert handle(ev(hook_event_name="Stop"), os.path.join(tmp, "nope"), root) is None

    # The generation timestamp is the LINK's, not the store path's frozen one.
    assert os.lstat(profile).st_mtime == 6000

    # The nagged command must be the one this host can actually run.
    assert REBUILD_CMD == (DARWIN_REBUILD_CMD if IS_DARWIN else LINUX_REBUILD_CMD)
    assert PROFILE_LINK == (DARWIN_PROFILE if IS_DARWIN else LINUX_PROFILE)

    for dirpath, dirnames, filenames in os.walk(tmp, topdown=False):
        for n in filenames:
            os.remove(os.path.join(dirpath, n))
        for n in dirnames:
            os.rmdir(os.path.join(dirpath, n))
    os.remove(profile) if os.path.islink(profile) else None
    os.rmdir(tmp)
    os.remove(spath)
    print("rebuild-enforcer selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
