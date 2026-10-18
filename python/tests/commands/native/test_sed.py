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
        pytest.param("sed s/hello/bye/", b"hello world\n", id="substitute"),
        pytest.param("sed s/o/0/g", b"foo boo\n", id="global"),
        pytest.param("sed s/o/0/", b"foo boo\n", id="first_only"),
        pytest.param("sed 2d", b"a\nb\nc\n", id="delete_line"),
        pytest.param("sed /foo/d", b"foo\nbar\nfoo2\n", id="delete_regex"),
        pytest.param("sed -n p", b"a\nb\nc\n", id="n_suppress"),
        pytest.param("sed -n 2p", b"a\nb\nc\n", id="n_with_address"),
        pytest.param("sed -n 2,4p", b"a\nb\nc\nd\ne\n", id="n_range"),
        pytest.param(
            "sed -n /hello/p",
            b"hello\nworld\nhello again\n",
            id="n_regex_address",
        ),
        pytest.param(
            "sed -E 's/[0-9]+/NUM/g'", b"foo123bar\nhello\n", id="E_extended"
        ),
        pytest.param(
            "sed -E 's/(hello) (world)/\\2 \\1/'",
            b"hello world\n",
            id="E_groups",
        ),
        pytest.param(
            "sed -nE '/[0-9]+/p'", b"abc123\ndef\nghi456\n", id="nE_combined"
        ),
        pytest.param("sed 's/o/O/2'", b"oooo\n", id="numeric_count"),
        pytest.param("sed 's/hi/HI/p'", b"hi\nbye\n", id="p_flag"),
        pytest.param("sed -n 's/hi/HI/p'", b"hi\nbye\n", id="n_p_flag"),
        pytest.param("sed 'y/el/ip/'", b"hello\n", id="y_transliterate"),
        pytest.param("sed '2c\\\nX'", b"a\nb\nc\n", id="c_single_address"),
        pytest.param("sed '2,3c\\\nX'", b"a\nb\nc\nd\n", id="c_range"),
        pytest.param(
            "sed 's/\\(foo\\)/[\\1]/'", b"foo\n", id="bre_group_backref"
        ),
        pytest.param("sed 's/a\\{2\\}/X/'", b"aaa\n", id="bre_interval"),
        pytest.param("sed 's/a+/X/'", b"a+b\n", id="bre_bare_plus_literal"),
        pytest.param("sed -E 's/(foo)/[\\1]/'", b"foo\n", id="ere_group_plus"),
        pytest.param(
            "sed -E 's/cat|dog/PET/'", b"dog\n", id="ere_alternation"
        ),
        pytest.param("sed -r 's/a+/X/'", b"aaab\n", id="r_alias"),
        pytest.param("sed -e 's/a/b/' -e 's/b/c/'", b"a\n", id="multiple_e"),
        pytest.param("sed '2!d'", b"a\nb\nc\n", id="negate_line"),
        pytest.param("sed '/b/!d'", b"a\nb\nc\n", id="negate_regex"),
        pytest.param("sed 's/o/O/'", b"foo", id="missing_final_newline"),
        pytest.param("sed 's/a\\/b/c/'", b"a/b\n", id="escaped_delimiter"),
    ],
)
def test_sed_stdin(env, cmd, data):
    assert env.mirage(cmd, stdin=data) == env.native(cmd, stdin=data)


def test_sed_on_file(env):
    env.create_file("f.txt", b"hello world\n")
    assert env.mirage("sed s/hello/bye/ /data/f.txt") == env.native(
        "sed s/hello/bye/ f.txt"
    )


def test_sed_n_on_file(env):
    env.create_file("f.txt", b"a\nb\nc\nd\ne\n")
    assert env.mirage("sed -n 2,3p /data/f.txt") == env.native(
        "sed -n 2,3p f.txt"
    )


def test_sed_i(env):
    env.create_file("f.txt", b"hello world\n")
    env.mirage("sed -i s/hello/bye/ /data/f.txt")
    result = env.mirage("cat /data/f.txt")
    assert "bye" in result


def test_sed_e(env):
    data = b"hello world\n"
    result = env.mirage("sed -e s/hello/bye/", stdin=data)
    assert "bye" in result


def test_sed_e_with_file(env):
    env.create_file("ef.txt", b"hello world\n")
    assert env.mirage("sed -e s/hello/bye/ /data/ef.txt") == env.native(
        "sed -e s/hello/bye/ ef.txt"
    )


def test_sed_f_script_file(env):
    env.create_file("prog.sed", b"s/hello/HI/\n")
    env.create_file("inf.txt", b"hello world\n")
    assert env.mirage("sed -f /data/prog.sed /data/inf.txt") == env.native(
        "sed -f prog.sed inf.txt"
    )


def test_sed_f_multiple_commands(env):
    env.create_file("prog2.sed", b"s/hello/HI/\ns/world/EARTH/\n")
    env.create_file("inf2.txt", b"hello world\n")
    assert env.mirage("sed -f /data/prog2.sed /data/inf2.txt") == env.native(
        "sed -f prog2.sed inf2.txt"
    )


def test_sed_e_and_f_combined(env):
    env.create_file("prog3.sed", b"s/world/EARTH/\n")
    env.create_file("inf3.txt", b"hello world\n")
    assert env.mirage(
        "sed -e s/hello/HI/ -f /data/prog3.sed /data/inf3.txt"
    ) == env.native("sed -e s/hello/HI/ -f prog3.sed inf3.txt")


def test_sed_f_stdin(env):
    env.create_file("prog4.sed", b"s/hello/HI/\n")
    data = b"hello world\n"
    assert env.mirage("sed -f /data/prog4.sed", stdin=data) == env.native(
        "sed -f prog4.sed", stdin=data
    )
