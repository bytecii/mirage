#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$1"
cd "$1"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=Ada GIT_AUTHOR_EMAIL=ada@example.com
export GIT_COMMITTER_NAME=Ada GIT_COMMITTER_EMAIL=ada@example.com
at() { export GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="${2:-$1}"; }
git init -q -b main
git config maintenance.auto false
git config gc.auto 0
git remote add origin https://example.com/demo.git
printf 'demo\n' > README.md
printf 'one\ntwo\nthree\n' > notes.txt
at 2024-06-01T10:00:00Z
git add -A
git commit -qm initial
printf 'demo\nmore\n' > README.md
at 2024-09-15T10:00:00Z
git commit -qam 'extend readme'
mkdir docs
git mv notes.txt docs/notes.md
at 2024-12-20T10:00:00Z
git commit -qm 'move notes'
git switch -qc side
printf 'feature\n' > feature.txt
printf 'demo\nmore from side\n' > README.md
at 2024-11-01T10:00:00Z 2025-02-10T10:00:00Z
git add -A
git commit -qm 'add feature'
git switch -q main
printf 'app\n' > app.txt
printf 'demo\nmore from main\n' > README.md
at 2025-03-01T10:00:00Z
git add -A
git commit -qm 'add app'
at 2025-04-01T10:00:00Z
if git merge -q side -m 'merge side' >/dev/null 2>&1; then
  echo 'expected a merge conflict' >&2
  exit 1
fi
printf 'demo\nmore from both\n' > README.md
git add README.md
git commit -qm 'merge side'
git switch -qc edited HEAD~2
git mv docs/notes.md docs/moved.md
printf 'four\n' >> docs/moved.md
printf '\000\001\002' > binary.dat
chmod +x README.md
at 2025-04-02T10:00:00Z
git add -A
git commit -qm 'rename with edits and binary addition'
git switch -q main
