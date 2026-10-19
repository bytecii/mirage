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


from tests.commands.builtin.conftest import file_workspace as _ws
from tests.commands.builtin.conftest import output_bytes as _bytes
from tests.commands.builtin.conftest import run_raw as _run_raw


def test_tar_create_and_list():
    ws = _ws(**{"/a.txt": b"aaa", "/b.txt": b"bbb"})
    _run_raw(ws, "tar -c -f /data/archive.tar /data/a.txt /data/b.txt")
    stdout, _ = _run_raw(ws, "tar -t -f /data/archive.tar", cwd="/data")
    out = _bytes(stdout).decode()
    assert "a.txt" in out
    assert "b.txt" in out


def test_tar_extract():
    ws = _ws(**{"/a.txt": b"content_a"})
    _run_raw(ws, "tar -c -f /data/archive.tar /data/a.txt")
    _run_raw(ws, "tar -x -f /data/archive.tar -C /data")
    stdout, _ = _run_raw(ws, "cat /data/a.txt")
    assert _bytes(stdout) == b"content_a"


def test_zip_and_unzip_list():
    ws = _ws(**{"/a.txt": b"hello"})
    _run_raw(ws, "zip /data/out.zip /data/a.txt")
    stdout, _ = _run_raw(ws, "unzip -l /data/out.zip")
    assert b"a.txt" in _bytes(stdout)


def test_unzip_extract():
    ws = _ws(**{"/a.txt": b"zip_content"})
    _run_raw(ws, "zip /data/out.zip /data/a.txt")
    _run_raw(ws, "unzip -d /data /data/out.zip")
    stdout, _ = _run_raw(ws, "cat /data/a.txt")
    assert _bytes(stdout) == b"zip_content"


def test_zip_j():
    ws = _ws(**{"/a.txt": b"hello"})
    _run_raw(ws, "mkdir -p /data/sub")
    _run_raw(ws, "cp /data/a.txt /data/sub/deep.txt")
    _run_raw(ws, "zip -j /data/out.zip /data/sub/deep.txt")
    stdout, _ = _run_raw(ws, "unzip -l /data/out.zip")
    out = _bytes(stdout).decode()
    assert "deep.txt" in out
    assert "sub/" not in out


def test_zip_q():
    ws = _ws(**{"/a.txt": b"hello"})
    stdout, _ = _run_raw(ws, "zip -q /data/out.zip /data/a.txt")
    assert stdout is None or _bytes(stdout) == b""
