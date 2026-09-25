# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import asyncio

from mirage.commands.builtin.generic.crossmount.stream import run_stream
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.types import PathSpec


def _scope(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual[:virtual.rfind("/") + 1],
                    vfs_path="",
                    resolved=True)


class FakeRunSingle:
    """Records run_single calls; serves per-path bytes for cat pushdowns."""

    def __init__(self, files: dict[str, bytes]):
        self.files = files
        self.calls: list[dict] = []
        self.final_stdin: bytes | None = None

    async def __call__(self,
                       cmd_name,
                       paths,
                       texts,
                       flag_kwargs,
                       stdin=None,
                       resolve_hint=None):
        self.calls.append(
            dict(cmd=cmd_name,
                 paths=[p.virtual for p in paths],
                 texts=list(texts),
                 flags=dict(flag_kwargs),
                 resolve_hint=resolve_hint.virtual
                 if resolve_hint is not None else None))
        if cmd_name == "cat" and paths:
            data = self.files.get(paths[0].virtual)
            if data is None:
                err = f"cat: {paths[0].virtual}: No such file\n".encode()
                return None, IOResult(exit_code=1, stderr=err)
            return data, IOResult()
        self.final_stdin = await materialize(stdin) if stdin is not None \
            else None
        return b"FINAL:" + (self.final_stdin or b""), IOResult()


def _run(coro):
    return asyncio.run(coro)


def test_plain_cat_skips_the_final_run():
    rs = FakeRunSingle({"/a/x": b"1\n", "/b/y": b"2\n"})
    out, io = _run(
        run_stream("cat", [_scope("/a/x"), _scope("/b/y")], [], {}, rs))
    assert _run(materialize(out)) == b"1\n2\n"
    assert io.exit_code == 0
    assert [c["cmd"] for c in rs.calls] == ["cat", "cat"]


def test_flagged_command_runs_once_on_the_merged_stream():
    rs = FakeRunSingle({"/a/x": b"1\n", "/b/y": b"2\n"})
    out, io = _run(
        run_stream("sort", [_scope("/a/x"), _scope("/b/y")], [], {"r": True},
                   rs))
    assert _run(materialize(out)) == b"FINAL:1\n2\n"
    assert io.exit_code == 0
    final = rs.calls[-1]
    assert final["cmd"] == "sort"
    assert final["paths"] == []
    assert final["flags"] == {"r": True}
    assert final["resolve_hint"] == "/a/x"
    assert rs.final_stdin == b"1\n2\n"


def test_cat_with_flags_reapplies_cat_on_the_merged_stream():
    rs = FakeRunSingle({"/a/x": b"1\n", "/b/y": b"2\n"})
    out, _ = _run(
        run_stream("cat", [_scope("/a/x"), _scope("/b/y")], [], {"n": True},
                   rs))
    assert _run(materialize(out)) == b"FINAL:1\n2\n"
    assert rs.calls[-1]["cmd"] == "cat"
    assert rs.calls[-1]["flags"] == {"n": True}


def test_failed_operand_is_skipped_and_fails_the_command():
    rs = FakeRunSingle({"/b/y": b"2\n"})
    out, io = _run(
        run_stream("cat",
                   [_scope("/a/missing"), _scope("/b/y")], [], {}, rs))
    assert _run(materialize(out)) == b"2\n"
    assert io.exit_code == 1
    assert b"No such file" in (io.stderr or b"")


class FetchFailures(FakeRunSingle):
    """Serves bytes for some operands and a cat-voiced failure for others."""

    def __init__(self, files: dict[str, bytes], failures: dict[str, str]):
        super().__init__(files)
        self.failures = failures

    async def __call__(self,
                       cmd_name,
                       paths,
                       texts,
                       flag_kwargs,
                       stdin=None,
                       resolve_hint=None):
        if cmd_name == "cat" and paths and paths[0].virtual in self.failures:
            self.calls.append(dict(cmd=cmd_name))
            path = paths[0].virtual
            line = f"cat: {path}: {self.failures[path]}"
            return None, IOResult(exit_code=1, stderr=f"{line}\n".encode())
        return await super().__call__(cmd_name, paths, texts, flag_kwargs,
                                      stdin, resolve_hint)


def test_sort_answers_one_refusal_ranked_like_the_single_mount_generic():
    rs = FetchFailures({}, {
        "/a/dir": "Is a directory",
        "/b/missing": "No such file or directory",
    })
    out, io = _run(
        run_stream("sort",
                   [_scope("/a/dir"), _scope("/b/missing")], [], {}, rs))
    assert out is None
    assert io.stderr == (b"sort: cannot read: /b/missing: "
                         b"No such file or directory\n")
    assert io.exit_code == 2
    assert [c["cmd"] for c in rs.calls] == ["cat", "cat"]


def test_sort_reports_a_directory_it_could_only_fail_to_read():
    rs = FetchFailures({"/b/y": b"a\n"}, {"/a/dir": "Is a directory"})
    _, io = _run(
        run_stream("sort", [_scope("/a/dir"), _scope("/b/y")], [], {}, rs))
    assert io.stderr == b"sort: read failed: /a/dir: Is a directory\n"
    assert io.exit_code == 2


def test_sort_refuses_its_own_line_before_fetching_anything():
    rs = FakeRunSingle({"/a/x": b"a\n", "/b/y": b"b\n"})
    _, io = _run(
        run_stream("sort", [_scope("/a/x"), _scope("/b/y")], [], {"C": True},
                   rs))
    assert io.stderr == b"sort: extra operand '/b/y' not allowed with -C\n"
    assert io.exit_code == 2
    _, io = _run(
        run_stream("sort", [_scope("/a/x"), _scope("/b/y")], [],
                   {"key": ["0"]}, rs))
    assert io.exit_code == 2
    assert b"invalid field specification" in (io.stderr or b"")
    assert rs.calls == []


def test_sort_ends_every_input_before_the_next_begins():
    rs = FakeRunSingle({"/a/x": b"b", "/b/y": b"a\n"})
    _run(run_stream("sort", [_scope("/a/x"), _scope("/b/y")], [], {}, rs))
    assert rs.final_stdin == b"b\na\n"
    rs = FakeRunSingle({"/a/x": b"b", "/b/y": b"a\x00"})
    _run(
        run_stream("sort", [_scope("/a/x"), _scope("/b/y")], [],
                   {"zero_terminated": True}, rs))
    assert rs.final_stdin == b"b\x00a\x00"


def test_sort_merge_sorts_the_merged_stream_it_cannot_merge():
    rs = FakeRunSingle({"/a/x": b"a\nc\n", "/b/y": b"b\n"})
    _run(
        run_stream("sort", [_scope("/a/x"), _scope("/b/y")], [], {
            "merge": True,
            "unique": True
        }, rs))
    assert rs.calls[-1]["flags"] == {"unique": True}
