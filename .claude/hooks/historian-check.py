#!/usr/bin/env python3
"""
Stop hook: detect changes to canonical docs and remind Claude to invoke @historian.

Fires on every Stop event. No-ops cleanly when:
- Already responding to a previous Stop hook (avoid loops)
- Not inside a git repo
- No uncommitted changes in watched paths
- Only journal files changed (excluded to prevent self-triggering)

Adapted from horizon's historian-check.py, scoped to Tokenvault's own canonical paths.
"""

import json
import os
import subprocess
import sys


WATCHED_PREFIXES = (
    "docs/adr/",
    "docs/prd.md",
    "docs/architecture.md",
    "docs/ux/",
    ".claude/skills/",
    ".claude/agents/",
    ".claude/commands/",
    ".claude/hooks/",
    "CLAUDE.md",
)

EXCLUDED_PREFIXES = (
    "docs/journal/",
)


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0

    if data.get("stop_hook_active"):
        return 0

    cwd = data.get("cwd") or os.getcwd()
    try:
        os.chdir(cwd)
    except Exception:
        return 0

    try:
        subprocess.run(
            ["git", "rev-parse", "--git-dir"],
            check=True,
            capture_output=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return 0

    result = subprocess.run(
        ["git", "status", "--porcelain"],
        capture_output=True,
        text=True,
    )

    files: list[str] = []
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        path = line[3:]
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        path = path.strip().strip('"')
        files.append(path)

    files = [f for f in files if not f.startswith(EXCLUDED_PREFIXES)]
    material = sorted({f for f in files if f.startswith(WATCHED_PREFIXES)})

    if not material:
        return 0

    file_list = "\n".join(f"  - {f}" for f in material)
    reason = (
        "Historian check: canonical docs changed this turn:\n"
        f"{file_list}\n\n"
        "Invoke @historian. The historian will: (1) decide if these are "
        "journal-worthy, (2) write a journal entry if so, (3) commit "
        "and push to origin/main. If the changes are trivial (typo, "
        "reformat, whitespace) or already logged, briefly note that "
        "and stop — trivial changes are not committed automatically."
    )

    print(json.dumps({"decision": "block", "reason": reason}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
