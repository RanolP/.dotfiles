#!/usr/bin/env python3
"""Fail when a local skill is unloadable or points at a file it does not ship.

Checks every nix/home/configs/.agents/skills/<dir>/SKILL.md:
  - the frontmatter opens the file and carries `name` and `description`,
  - each relative Markdown link, and each backticked path under one of the
    skill's own subfolders (references/, scripts/, formats/, ...), resolves
    inside the skill directory (a backticked path needs a file extension, so an
    upstream citation such as `references/feature-map-example` is not a file),
  - the directory has a `localSkill "<dir>"` line in nix/home/default.nix,
    since one-entry-per-skill wiring means an unlisted skill never deploys.

Usage: skills-check.py <skills-dir> <default.nix>
Self-check: skills-check.py --selftest
"""

import re
import sys
import tempfile
from pathlib import Path

FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.S)
MD_LINK = re.compile(r"\]\(([^)\s#]+)(?:#[^)]*)?\)")
TICKED = re.compile(r"`([\w.-]+/[^`\s]*\.\w+)`")
INLINE_CODE = re.compile(r"`[^`\n]*`")
PLACEHOLDER = re.compile(r"[<>*{}$|]|\.\.\.")


def own_subdirs(skill):
    return {p.name for p in skill.iterdir() if p.is_dir()}


def problems(skill, wired):
    out = []
    md = skill / "SKILL.md"
    if not md.is_file():
        return [f"{skill.name}: no SKILL.md"]
    text = md.read_text()
    fm = FRONTMATTER.match(text)
    if not fm:
        out.append(f"{skill.name}/SKILL.md: no --- frontmatter block at the top")
    else:
        for key in ("name", "description"):
            if not re.search(rf"^{key}:\s*\S", fm.group(1), re.M):
                out.append(f"{skill.name}/SKILL.md: frontmatter has no {key}")
    subdirs = own_subdirs(skill)
    # A link written inside a code span is an example, and a bare word such as
    # (url) is a placeholder; only a target naming a file or folder counts.
    targets = [m for m in MD_LINK.findall(INLINE_CODE.sub(" ", text))
               if "://" not in m and not m.startswith(("/", "~", "mailto:")) and re.search(r"[./]", m)]
    targets += [m for m in TICKED.findall(text) if m.split("/", 1)[0] in subdirs]
    for rel in targets:
        if PLACEHOLDER.search(rel):
            continue
        if not (skill / rel).exists():
            out.append(f"{skill.name}/SKILL.md: references {rel}, which is not in the skill directory")
    if skill.name not in wired:
        out.append(f'{skill.name}: no localSkill "{skill.name}" line in nix/home/default.nix')
    return out


def check(skills_dir, default_nix):
    wired = set(re.findall(r'localSkill\s+"([^"]+)"', Path(default_nix).read_text()))
    found = []
    for skill in sorted(p for p in Path(skills_dir).iterdir() if p.is_dir() and not p.name.startswith(".")):
        found += problems(skill, wired)
    return found


def selftest():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        nix = root / "default.nix"
        nix.write_text('good = localSkill "good";\nbad = localSkill "bad";\n')
        good = root / "skills/good"
        (good / "references").mkdir(parents=True)
        (good / "references/a.md").write_text("x")
        (good / "SKILL.md").write_text(
            "---\nname: good\ndescription: d\n---\nSee [a](references/a.md), `references/a.md`,"
            " `references/<topic>.md`, `src/elsewhere.py`, [web](https://x.y/z),"
            " `[label](url)`, \"[label](url)\", upstream `references/upstream-only`.\n")
        bad = root / "skills/bad"
        bad.mkdir()
        (bad / "scripts").mkdir()
        (bad / "SKILL.md").write_text("---\nname: bad\n---\nRun `scripts/missing.sh`.\n")
        lone = root / "skills/lone"
        lone.mkdir()
        (lone / "SKILL.md").write_text("no frontmatter\n")
        got = check(root / "skills", nix)
        assert not [g for g in got if g.startswith("good")], got
        assert "bad/SKILL.md: frontmatter has no description" in got, got
        assert any("scripts/missing.sh" in g for g in got), got
        assert any(g.startswith("lone/SKILL.md: no ---") for g in got), got
        assert any(g.startswith('lone: no localSkill') for g in got), got
    print("skills-check selftest ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--selftest"]:
        selftest()
        sys.exit(0)
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    found = check(sys.argv[1], sys.argv[2])
    for line in found:
        print("skills-check: " + line, file=sys.stderr)
    sys.exit(1 if found else 0)
