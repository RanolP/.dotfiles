#!/usr/bin/env python3
"""Small assert-based check for leading Bash `cd` folding."""
import os
import tempfile

from command_cwd import fold_leading_cd


def main():
    with tempfile.TemporaryDirectory() as td:
        cwd = os.path.join(td, "repo")
        sub_dir = os.path.join(cwd, "sub dir")
        other_repo = os.path.join(td, "other", "repo")
        one = os.path.join(cwd, "one")
        for path in (sub_dir, other_repo, one):
            os.makedirs(path)

        assert fold_leading_cd("git status", cwd) == (cwd, "git status")
        assert fold_leading_cd("cd 'sub dir' && git status", cwd) == (
            sub_dir, "git status"
        )
        assert fold_leading_cd(f'cd "{other_repo}" && git commit -m x', cwd) == (
            other_repo, "git commit -m x"
        )
        assert fold_leading_cd("cd ~ && pwd", cwd) == (
            os.path.expanduser("~"), "pwd"
        )
        assert fold_leading_cd("cd one && cd two && pwd", cwd) == (
            one, "cd two && pwd"
        )
        assert fold_leading_cd("echo x && cd sub && pwd", cwd) == (
            cwd, "echo x && cd sub && pwd"
        )
        for command in (
            'cd "$(git rev-parse --show-toplevel)" && git commit -m x',
            "cd - && git commit -m x",
            "cd $PWD && git commit -m x",
        ):
            assert fold_leading_cd(command, cwd) == (cwd, command)
    print("test_command_cwd: 9 passed")


if __name__ == "__main__":
    main()
