# TS VFS/FUSE reads are not recorded in workspace ops

## Symptom

The trailing `Stats:` line diverges between the Python and TypeScript examples even when all content output is byte-identical:

- Python `notion_fuse.py`: `Stats: 13 ops, 42904 bytes`
- TypeScript `notion_fuse.ts`: `Stats: 0 ops, 0 bytes transferred`

Same for the `_vfs` examples (`patchNodeFs`): Python reports `4 ops, 20760 bytes`, TS reports `0 ops, 0 bytes`.

## Cause

In TypeScript, `ws.fs.readFile` / `ws.fs.readdir` (used by `patchNodeFs` and the FUSE layer in `packages/node/src/fuse/fs.ts`) bypass the record-keeping dispatch, so nothing lands in `ws.records`. In Python, the equivalent VFS and FUSE paths go through `apply_io`, which appends `OpRecord`s, so `ws.ops.records` counts every read.

## Scope

Cross-backend, not notion-specific: Linear's TS `_vfs`/`_fuse` examples have the same gap, and any resource read through `ws.fs` or a FUSE mount is unrecorded. Command execution (`ws.execute`) records normally in both languages.

## Fix direction

Route `ws.fs` reads (or at least the FUSE/`patchNodeFs` entry points) through the same dispatch/recording layer the executor uses, mirroring Python's `apply_io` accounting. Then the example `Stats:` lines become comparable across languages.

## Status

Open. Found 2026-06-09 while verifying notion example parity (PR #226); deferred because the fix belongs in the workspace fs op layer, not per-backend.
