# microsandbox tests

Tests `fuse`, `ssh` and `both` against a real guest. This setup is only for
integration tests, not normal Mirage usage.

Use a disposable guest: the tests restart it and temporarily disable
`/dev/fuse`.

## Prepare

Install the released `msb` CLI and build the Node packages. From the repo root:

```bash
uv build --wheel python --out-dir /tmp/mirage-wheels
msb create python:3.12-slim-bookworm --name mirage-e2e --memory 1G
bash integ/runtime/microsandbox/setup-test-guest.sh mirage-e2e /tmp/mirage-wheels/mirage_ai-*.whl
```

## Run

Run either command:

```bash
# Python
MIRAGE_E2E_SANDBOX=mirage-e2e python/.venv/bin/python integ/runtime/microsandbox/live.py

# TypeScript
MIRAGE_E2E_SANDBOX=mirage-e2e integ/node_modules/.bin/tsx integ/runtime/microsandbox/live.ts
```

Rerun the setup script before another test run to restore the guest's mounts.

Remove the guest when finished:

```bash
msb remove --force mirage-e2e
```
