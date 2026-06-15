#!/usr/bin/env bash
# CLI end-to-end FUSE parity. Drives the daemon-backed CLI to create a workspace
# with TWO per-mount FUSE subtrees pinned to known OS paths, writes content
# through the VFS, then reads it back THROUGH the kernel mountpoints. The daemon
# hosts the mounts in its own process, so the reading shell never deadlocks.
# Proves the CLI really mounts each subtree at its own path on both languages.
# Requires libfuse + /dev/fuse, so it runs only in the fuse CI job.
#
# Usage: cli_fuse.sh "<py-cli>" "<ts-cli>"
set -uo pipefail

PY_CLI="${1:?python mirage cli command}"
TS_CLI="${2:?typescript mirage cli command}"
fail=0

points() { jq -r '.fuse_mountpoints // .fuseMountpoints'; }

# Run the full CLI battery against one CLI; emit one "key=value" line per probe.
probe() {
  local cli="$1" lang="$2"
  local dmnt="/tmp/cli-fuse-$lang-data"
  local lmnt="/tmp/cli-fuse-$lang-logs"
  fusermount -u "$dmnt" 2>/dev/null || umount "$dmnt" 2>/dev/null || true
  fusermount -u "$lmnt" 2>/dev/null || umount "$lmnt" 2>/dev/null || true
  rm -rf "$dmnt" "$lmnt"

  local yaml="/tmp/cli-fuse-$lang.yaml"
  cat > "$yaml" <<YML
mode: WRITE
mounts:
  /data:
    resource: ram
    fuse: $dmnt
  /logs:
    resource: ram
    fuse: $lmnt
YML

  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  sleep 1
  $cli workspace delete cf >/dev/null 2>&1 </dev/null || true
  $cli workspace create "$yaml" --id cf >/dev/null </dev/null

  # RAM mounts start empty; seed through the VFS. The live workspace is what
  # FUSE serves, so these writes are immediately visible at the mountpoints.
  $cli execute -w cf -c 'echo alpha > /data/a.txt' </dev/null >/dev/null
  $cli execute -w cf -c 'echo beta > /logs/b.txt' </dev/null >/dev/null

  # The daemon mounts asynchronously; wait for both files to appear via the OS.
  local i
  for i in $(seq 1 50); do
    [ -f "$dmnt/a.txt" ] && [ -f "$lmnt/b.txt" ] && break
    sleep 0.2
  done

  local detail data_mp logs_mp
  detail="$($cli workspace get cf </dev/null)"
  data_mp="$(printf '%s' "$detail" | points | jq -r '."/data" // empty')"
  logs_mp="$(printf '%s' "$detail" | points | jq -r '."/logs" // empty')"

  echo "data_cat=$(cat "$dmnt/a.txt" 2>/dev/null)"
  echo "logs_cat=$(cat "$lmnt/b.txt" 2>/dev/null)"
  echo "logs_size=$(wc -c < "$lmnt/b.txt" 2>/dev/null | tr -d ' ')"
  echo "mount_keys=$(printf '%s' "$detail" | points | jq -r 'keys | sort | join(",")')"
  echo "data_pinned=$([ "$data_mp" == "$dmnt" ] && echo yes || echo no)"
  echo "logs_pinned=$([ "$logs_mp" == "$lmnt" ] && echo yes || echo no)"
  echo "distinct=$([ -n "$data_mp" ] && [ "$data_mp" != "$logs_mp" ] && echo yes || echo no)"

  $cli workspace delete cf >/dev/null 2>&1 </dev/null || true
  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  fusermount -u "$dmnt" 2>/dev/null || umount "$dmnt" 2>/dev/null || true
  fusermount -u "$lmnt" 2>/dev/null || umount "$lmnt" 2>/dev/null || true
}

echo "===== probing Python CLI ====="
probe "$PY_CLI" py | sort > /tmp/cli-fuse-py.txt
echo "===== probing TypeScript CLI ====="
probe "$TS_CLI" ts | sort > /tmp/cli-fuse-ts.txt

echo
echo "===== Python results ====="
cat /tmp/cli-fuse-py.txt

echo
echo "===== language parity (py vs ts) ====="
if diff -u /tmp/cli-fuse-py.txt /tmp/cli-fuse-ts.txt; then
  echo "  OK   Python and TypeScript produced identical results"
else
  echo "  FAIL Python and TypeScript diverged (see diff above)"
  fail=1
fi

echo
echo "===== expected values ====="
expect() {
  local key="$1" want="$2"
  local got
  got="$(grep -F "$key=" /tmp/cli-fuse-py.txt | head -1 | cut -d= -f2-)"
  if [ "$got" == "$want" ]; then
    echo "  OK   $key == $(printf '%q' "$want")"
  else
    echo "  FAIL $key: got $(printf '%q' "$got") expected $(printf '%q' "$want")"
    fail=1
  fi
}
expect "data_cat" "alpha"
expect "logs_cat" "beta"
expect "logs_size" "5"
expect "mount_keys" "/data,/logs"
expect "data_pinned" "yes"
expect "logs_pinned" "yes"
expect "distinct" "yes"

if [ "$fail" != "0" ]; then
  echo
  if [ -f "$HOME/.mirage/daemon.log" ]; then
    echo "===== ~/.mirage/daemon.log (last 60 lines) ====="
    tail -60 "$HOME/.mirage/daemon.log"
    echo
  fi
  echo "CLI FUSE parity FAILED."
  exit 1
fi
echo
echo "CLI FUSE parity OK (two pinned per-mount FUSE subtrees read through the kernel; py == ts)."
