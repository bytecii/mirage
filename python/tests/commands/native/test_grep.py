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


import pytest


@pytest.mark.parametrize(
    "cmd, data",
    [
        pytest.param(
            "grep hello", b"hello world\nfoo bar\nhello again\n", id="basic"
        ),
        pytest.param("grep -i hello", b"Hello\nworld\nHELLO\n", id="i"),
        pytest.param("grep -v hello", b"hello\nworld\nfoo\n", id="v"),
        pytest.param("grep -n hello", b"hello\nworld\nhello\n", id="n"),
        pytest.param("grep -c hello", b"hello\nworld\nhello\n", id="c"),
        pytest.param(
            "grep -w hello", b"hello\nhelloworld\nhello there\n", id="w"
        ),
        pytest.param("grep -F 'a.b'", b"a.b\na*b\naXb\n", id="F"),
        pytest.param("grep -o hello", b"hello world\nfoo hello\n", id="o"),
        pytest.param("grep -m 2 a", b"a\na\na\na\n", id="m"),
        pytest.param("grep -iv hello", b"Hello\nworld\nHELLO\nfoo\n", id="iv"),
        pytest.param(
            "grep -nw hello", b"hello\nhelloworld\nhello there\n", id="nw"
        ),
        pytest.param("grep -Fc 'a.b'", b"a.b\na.b\naXb\n", id="Fc"),
        pytest.param("grep zzz", b"hello\nworld\n", id="no_match"),
        pytest.param("grep -A 1 c", b"a\nb\nc\nd\ne\n", id="A"),
        pytest.param("grep -B 1 c", b"a\nb\nc\nd\ne\n", id="B"),
        pytest.param("grep -C 1 c", b"a\nb\nc\nd\ne\n", id="C"),
        pytest.param(
            "grep -A 1 a", b"x\na\nb\nc\na\nd\ne\n", id="A_multiple_matches"
        ),
        pytest.param(
            "grep -B 1 a", b"x\ny\na\nb\nc\na\n", id="B_multiple_matches"
        ),
        pytest.param(
            "grep -C 1 a", b"w\nx\na\ny\nz\na\nb\n", id="C_multiple_matches"
        ),
        pytest.param("grep -A 2 a", b"a\nb\na\nc\nd\n", id="A_overlapping"),
        pytest.param("grep -n -A 1 c", b"a\nb\nc\nd\ne\n", id="An_combined"),
        pytest.param("grep -C 1 -i aaa", b"aaa\nbbb\nAAA\nccc\n", id="Ci"),
    ],
)
def test_grep_file(env, cmd, data):
    env.create_file("f.txt", data)
    assert env.mirage(f"{cmd} /data/f.txt") == env.native(f"{cmd} f.txt")


def test_grep_stdin(env):
    data = b"hello world\nfoo bar\nhello again\n"
    assert env.mirage("grep hello", stdin=data) == env.native(
        "grep hello", stdin=data
    )


def test_grep_stdin_i(env):
    data = b"Hello\nworld\nHELLO\n"
    assert env.mirage("grep -i hello", stdin=data) == env.native(
        "grep -i hello", stdin=data
    )


def test_grep_stdin_c(env):
    data = b"a\nb\na\n"
    assert env.mirage("grep -c a", stdin=data) == env.native(
        "grep -c a", stdin=data
    )


def test_grep_e_stdin(env):
    data = b"hello\nworld\nfoo\n"
    assert env.mirage("grep -e hello", stdin=data) == env.native(
        "grep -e hello", stdin=data
    )


def test_grep_A_stdin(env):
    data = b"a\nb\nc\nd\ne\n"
    assert env.mirage("grep -A 1 c", stdin=data) == env.native(
        "grep -A 1 c", stdin=data
    )


def test_grep_C_stdin(env):
    data = b"a\nb\nc\nd\ne\n"
    assert env.mirage("grep -C 1 c", stdin=data) == env.native(
        "grep -C 1 c", stdin=data
    )


def test_grep_r(env):
    env.create_file("f.txt", b"hello\nworld\n")
    result = env.mirage("grep -r -l hello /data")
    assert "f.txt" in result


def test_grep_l(env):
    env.create_file("a.txt", b"hello\n")
    result = env.mirage("grep -r -l hello /data")
    assert "a.txt" in result


def test_grep_E(env):
    data = b"foo\nbar\nbaz\n"
    assert env.mirage("grep -E 'foo|bar'", stdin=data) == env.native(
        "grep -E 'foo|bar'", stdin=data
    )


def test_grep_q(env):
    env.create_file("f.txt", b"hello\n")
    result = env.mirage("grep -q hello /data/f.txt")
    assert result == ""


def test_grep_R(env):
    env.create_file("f.txt", b"hello\n")
    result = env.mirage("grep -R hello /data")
    assert "hello" in result


def test_grep_H(env):
    env.create_file("f.txt", b"hello\n")
    result = env.mirage("grep -H hello /data/f.txt")
    assert "hello" in result


def test_grep_h(env):
    env.create_file("f.txt", b"hello\n")
    result = env.mirage("grep -r -h hello /data")
    assert "hello" in result
