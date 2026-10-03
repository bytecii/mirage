# Runtime

These suites run guest programs against mirage mounts: Python on monty,
wasi and pyodide, and JavaScript on quickjs. Each case runs through
`run.py` (the python host), `run.ts` (the typescript host) and `cli.sh`
(both CLIs and their daemons). The sandbox suites at the end send whole
lines to a box the user runs.

| Runtime | Python host                                                   | TypeScript host                                |
| ------- | ------------------------------------------------------------- | ---------------------------------------------- |
| monty   | `pydantic_monty`, file calls via OS callbacks                 | `@pydantic/monty`, file calls via OS callbacks |
| wasi    | CPython built for WASI, in wasmtime                           | not on this host                               |
| pyodide | not on this host                                              | Pyodide, Emscripten FS with a journal          |
| quickjs | `qjs` from quickjs-ng built for WASI, same WASI layer as wasi | quickjs-emscripten with a `std`/`os` shim      |

## How a case reads

- `runtimes` lists the runtimes a case runs on; each becomes the variant
  `<case>@<runtime>`, skipped on a host that lacks the runtime.
- A step gives its guest code once per language: `program` (inline,
  run as `python3 -c` or `node -e`), `script` (a file under
  `integ/fixtures/runtime/`) or `command` (a raw line). A step without the
  runtime's language is left out of that variant.
- `expect` is the shared answer, CPython's on Linux. `expect_on` overrides
  it by `runtime`, `runtime@host`, `backend` or `runtime@backend`. Every
  override is a recorded difference; the tables below name them.
- `backends` repeats a case over `ram`, `s3` and `redis`; each mount gets
  its own key space.

## Coverage

Each row is one suite. `yes` means the runtime gives the shared answer on
that host, `differs` that it runs with a recorded override (the note says
how), and `no` that the runtime has no such call (the case pins the
error, or checks that the call is absent).

### What the guests call

| Area                   | Suite          | Python guests                                                                                                           | QuickJS guests                                 |
| ---------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| List a directory       | `readdir.json` | `os.listdir`, `Path.iterdir`, `Path.is_dir`, `Path.exists`, nested mounts, a failing record                             | `os.readdir`, `os.stat`                        |
| Above mounts and links | `readdir.json` | `os.stat`, `os.listdir` and `open` on the tree above the mounts and through a link                                      | `os.stat`, `os.readdir`, `std.open`            |
| Stat                   | `stat.json`    | `os.stat` (fields and tuple form), `Path.stat`, `is_file`, `is_dir`, `exists`, the root                                 | `os.stat`, `S_IFMT`                            |
| Glob and walk          | `glob.json`    | `glob.glob` (recursive), `Path.glob`, `Path.rglob`, `os.walk`, `os.scandir`                                             | checks that `os` has no glob                   |
| `os.path`              | several        | `os.path.exists`, `os.path.islink`                                                                                      | none                                           |
| Open modes             | `open.json`    | `open` in `r`, `w`, `a`, `x`, `+` and binary modes, their errors, malformed modes, `os.fstat`, content outside the view | `std.open` in the same modes, `errorObj`       |
| Read                   | `read.json`    | `read`, `read_text`, `read_bytes`, line iteration, a file over 1 MiB                                                    | `read`, `getline`, `readAsString`              |
| Seek and ranged reads  | `pread.json`   | `seek`, `tell`, `read(n)`, `os.open`, `os.pread`, `os.lseek`                                                            | `seek`, `tell`, `read`, `SEEK_SET`, `SEEK_END` |
| Write and append       | `write.json`   | `open` in `w` and `a`, `write_text`, `write_bytes`, a read-only mount, three appends, a mount at `/`                    | `std.open`, `puts`, `write`                    |
| Make directories       | `mkdir.json`   | `os.mkdir`, `os.makedirs`, `Path.mkdir`                                                                                 | `os.mkdir`                                     |
| Remove directories     | `rmdir.json`   | `os.rmdir`, `Path.rmdir`, `shutil.rmtree`                                                                               | `os.remove`                                    |
| Remove files           | `unlink.json`  | `os.remove`, `Path.unlink`, unlinking a directory                                                                       | `os.remove`                                    |
| Rename                 | `rename.json`  | `os.rename`, `os.replace`, `Path.rename`, `shutil.move`, across mounts (EXDEV)                                          | `os.rename`                                    |
| Symlinks               | `symlink.json` | `os.symlink`, `os.readlink`, `os.lstat`, `os.path.islink`, `Path.is_symlink`, `os.scandir`                              | none (see note 21)                             |
| Hard links             | `link.json`    | `os.link` (EPERM)                                                                                                       | none                                           |
| Times and modes        | `utime.json`   | `os.utime`, `os.utime(follow_symlinks=False)`, `os.chmod`                                                               | `os.utimes`                                    |
| Extended attributes    | `xattr.json`   | `os.getxattr`, `setxattr`, `listxattr`, `removexattr`                                                                   | checks that they are absent                    |
| Working directory      | `cwd.json`     | the shell's `cd`, `os.getcwd`, `os.chdir`, relative paths in every call                                                 | `os.getcwd`, `os.chdir`, relative paths        |

### Results

| Area                   | monty (py)   | monty (ts)       | wasi (py)      | pyodide (ts) | quickjs (py)      | quickjs (ts) |
| ---------------------- | ------------ | ---------------- | -------------- | ------------ | ----------------- | ------------ |
| List a directory       | differs (1)  | differs (1)      | yes            | yes          | yes               | yes          |
| Above mounts and links | yes          | yes              | yes            | differs (2)  | yes               | yes          |
| Stat                   | yes          | differs (3)      | differs (4, 5) | differs (4)  | differs (4, 5, 6) | differs (4)  |
| Glob and walk          | no (7)       | no (7)           | yes            | yes          | no                | no           |
| `os.path`              | yes (8)      | yes (8)          | yes            | yes          | none              | none         |
| Open modes             | differs (9)  | differs (9)      | yes            | differs (10) | differs (11)      | differs (12) |
| Read                   | differs (13) | differs (13)     | yes            | yes          | yes               | yes          |
| Seek and ranged reads  | differs (14) | differs (14)     | yes            | yes          | yes               | differs (15) |
| Write and append       | yes          | differs (16)     | yes            | differs (17) | yes               | differs (18) |
| Make directories       | differs (19) | differs (19)     | differs (19)   | yes          | yes               | yes          |
| Remove directories     | differs (20) | differs (20)     | yes            | yes          | yes               | yes          |
| Remove files           | differs (22) | differs (22)     | differs (22)   | yes          | yes               | yes          |
| Rename                 | differs (20) | differs (20)     | differs (23)   | yes          | differs (23)      | differs (23) |
| Symlinks               | no (24)      | no (24)          | yes            | differs (2)  | no (21)           | no (21)      |
| Hard links             | no           | no               | yes            | no           | no                | no           |
| Times and modes        | no           | no               | differs (25)   | differs (26) | yes               | yes          |
| Extended attributes    | no           | no               | no             | yes          | no                | no           |
| Working directory      | differs (27) | differs (27, 28) | differs (29)   | yes          | differs (29)      | yes          |

1. A backend that fails mid-listing raises `RuntimeError`, not `OSError` (EIO).
2. A write above the mounts lands in Pyodide's own in-memory file system,
   and a link that aliases a mount is not found.
3. `os.stat` returns no tuple form: `st[6]` fails.
4. The root reports `nlink` 1; CPython on Linux reports 2.
5. Directories carry no permission bits (`0o40000`).
6. `std.open` opens a directory; the TypeScript shim refuses it.
7. No `glob` module, `Path.rglob`, `os.walk` or `os.scandir`.
8. Only `os.path.exists` runs on monty; `os.path.islink` sits in the link
   cases monty skips. `isdir`, `isfile`, `getsize`, `join` and `realpath`
   are not covered yet.
9. No `+` or `x` modes and no `fileno()`; `FileNotFoundError` carries no
   `strerror` or `filename`.
10. Create, truncate and append reach the mount as whole writes when the
    journal flushes; `x` on a dangling link opens; a file outside the view
    opens in Pyodide's in-memory file system.
11. Accepts the mode `rr`, as QuickJS itself does.
12. `std.open` leaves its `errorObj` argument unset.
13. File objects are not iterable, and there is no `glob` module.
14. No `os.open`, `os.pread` or `os.lseek`; `seek` and `tell` on a file work.
15. `std.SEEK_SET` and `std.SEEK_END` are missing, so `seek` does nothing.
16. A read-only mount refuses with `OSError`, not `PermissionError`.
17. A read-only refusal shows only when the journal flushes at exit, and a
    mount at `/` is not served.
18. `write(ArrayBuffer)` writes the text `[object ArrayBuffer]`, and
    `errorObj` stays unset.
19. On S3, `mkdir` under a missing parent succeeds: the S3 backend has no
    directories to check. Pyodide checks the parent itself and refuses.
20. No `shutil` module, and no `errno` module to name EXDEV.
21. qjs builds without `os.symlink`, `os.readlink` and `os.lstat`, and the
    TypeScript shim matches it.
22. Unlinking a directory on RAM or redis raises `FileNotFoundError`, not
    `IsADirectoryError`.
23. A rename across mounts fails with ENOENT, not EXDEV.
24. No `os.symlink`, `os.readlink` or `os.lstat`; `Path.is_symlink` works.
25. `os.chmod` does nothing.
26. `os.utime(follow_symlinks=False)` raises `NotImplementedError`.
27. A module attribute cannot be reassigned (`os.chdir = ...`).
28. `os.chdir` fails: the host must return a `stat_result`.
29. `os.getcwd()` after `chdir('..')` keeps the `..` (`/data/sub/..`).

### Runtime-specific suites

| Suite          | Covers                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `monty.json`   | `python`/`python3` heads, argv, stdin, pipes, env, timeouts, output after a failure, known CPython gaps, `os.urandom`, policy on relative writes |
| `wasi.json`    | `sys.argv`, the script directory on `sys.path`, closed output and reuse                                                                          |
| `pyodide.json` | eval, preload, cwd fallback, stream capture, memory growth, tracebacks, flags and import paths                                                   |
| `quickjs.json` | eval, `print`/`puts`/`printf`, argv, stdin operands, policy scripts, output after a failure                                                      |
| `local.json`   | the host's own interpreter: argv, script names, init flags, stdin operand policy                                                                 |

## Sandboxes

A sandbox runs the whole line on its own machine, so these suites check the
line door, not file calls: a file the line touches lives on the box.

| Suite                  | Covers                                                                 | Runs in CI         |
| ---------------------- | ---------------------------------------------------------------------- | ------------------ |
| `docker.json`          | echo, exit code, stdin, config env, line timeout, captured commands    | yes                |
| `ssh.json`             | the docker cases, stdin end of input, quoting                          | yes                |
| `e2b.json`             | the ssh cases, against E2B Embed on the runner                         | yes (`integ-e2b`)  |
| `smolvm.json`          | the docker cases and the guest's own kernel                            | no, needs KVM host |
| `apple_container.json` | the docker cases, stderr, env, an unserved cwd, per-session containers | no, needs macOS 26 |
| `sandlock.json`        | real CPython and node under Landlock, granted and refused writes       | no, needs Landlock |

## Running

```bash
./python/.venv/bin/python integ/runtime/run.py readdir pread
```

```bash
cd integ && pnpm exec tsx runtime/run.ts readdir pread
```

```bash
bash integ/runtime/cli.sh python/.venv/bin/mirage "node typescript/packages/cli/dist/bin/mirage.js" readdir
```

wasi needs `MIRAGE_WASI_HOME`, quickjs on the python host needs
`MIRAGE_QUICKJS_HOME`, the `s3` variants need `S3_ENDPOINT` on the
typescript host, and the `redis` variants need `REDIS_URL`. With
`INTEG_RUNTIME_STRICT=1` an unmet requirement fails instead of skipping.
