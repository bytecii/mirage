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
    "cmd, left, right",
    [
        pytest.param(
            "join -a 1", b"1 a\n2 b\n3 c\n", b"2 x\n3 y\n4 z\n", id="a1"
        ),
        pytest.param(
            "join -v 1", b"1 a\n2 b\n3 c\n", b"2 x\n3 y\n4 z\n", id="v1"
        ),
        pytest.param(
            "join -a 1 -e EMPTY", b"1 a\n2 b\n", b"1 x\n3 y\n", id="e"
        ),
        pytest.param("join -t :", b"1:a\n2:b\n", b"1:x\n2:y\n", id="t"),
        pytest.param(
            "join -o 0,1.2,2.3", b"1 a c\n2 b d\n", b"1 x z\n2 y w\n", id="o"
        ),
        pytest.param(
            "join -a 1 -e NA -o 0,1.2,2.2",
            b"1 a\n2 b\n",
            b"1 x\n3 z\n",
            id="o_empty",
        ),
        pytest.param("join -1 2 -2 1", b"a 1\nb 2\n", b"1 x\n2 y\n", id="12"),
    ],
)
def test_join(env, cmd, left, right):
    env.create_file("a.txt", left)
    env.create_file("b.txt", right)
    assert env.mirage(f"{cmd} /data/a.txt /data/b.txt") == env.native(
        f"{cmd} a.txt b.txt"
    )
