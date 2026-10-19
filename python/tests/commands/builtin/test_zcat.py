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

import gzip

from tests.commands.builtin.conftest import output_bytes as _bytes
from tests.commands.builtin.conftest import ram_workspace as _ws
from tests.commands.builtin.conftest import run_raw as _run_raw


def test_zcat():
    ws, _ = _ws()
    compressed = gzip.compress(b"hello world\n")
    _run_raw(ws, "tee /data/f.gz", stdin=compressed)
    stdout, io = _run_raw(ws, "zcat /data/f.gz")
    assert _bytes(stdout) == b"hello world\n"


def test_zcat_reports_a_plain_input_and_goes_on():
    ws, _ = _ws()
    _run_raw(ws, "tee /data/plain.txt", stdin=b"hello\n")
    _run_raw(ws, "tee /data/h.gz", stdin=gzip.compress(b"hi\n"))
    stdout, io = _run_raw(ws, "zcat /data/plain.txt /data/h.gz")
    assert _bytes(stdout) == b"hi\n"
    assert (
        _bytes(io.stderr) == b"\ngzip: /data/plain.txt: not in gzip format\n"
    )
    assert io.exit_code == 1


def test_zcat_stops_at_a_truncated_archive():
    ws, _ = _ws()
    _run_raw(ws, "tee /data/cut.gz", stdin=gzip.compress(b"hello\n")[:10])
    _run_raw(ws, "tee /data/h.gz", stdin=gzip.compress(b"hi\n"))
    stdout, io = _run_raw(ws, "zcat /data/cut.gz /data/h.gz")
    assert _bytes(stdout) == b""
    assert (
        _bytes(io.stderr) == b"\ngzip: /data/cut.gz: unexpected end of file\n"
    )
    assert io.exit_code == 1


def test_zcat_calls_empty_stdin_an_unexpected_end():
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "zcat")
    assert (_bytes(io.stderr), io.exit_code) == (
        b"\ngzip: stdin: unexpected end of file\n",
        1,
    )


def test_zcat_reads_a_dash_after_a_refused_operand():
    ws, _ = _ws()
    _run_raw(ws, "tee /data/plain.txt", stdin=b"hello\n")
    stdout, io = _run_raw(
        ws, "zcat plain.txt -", cwd="/data", stdin=gzip.compress(b"hi\n")
    )
    assert _bytes(stdout) == b"hi\n"
    assert _bytes(io.stderr) == b"\ngzip: plain.txt: not in gzip format\n"
