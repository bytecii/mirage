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

from mirage.core.disk.utils import resolve_inside


@pytest.fixture
def tree(tmp_path):
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    (root / "lib").mkdir(parents=True)
    (root / "lib" / "a.txt").write_text("a")
    outside.mkdir()
    (outside / "secret.txt").write_text("s")
    (root / "lib64").symlink_to("lib")
    (root / "abs").symlink_to(outside / "secret.txt")
    (root / "dangling").symlink_to("../nope/python3")
    return root


def test_answers_the_host_path_with_no_link_in_it(tree):
    assert resolve_inside(tree, "/lib/a.txt",
                          "/lib/a.txt") == tree / "lib" / "a.txt"


def test_answers_a_path_past_an_absent_component(tree):
    assert resolve_inside(tree, "/new/x.txt",
                          "/new/x.txt") == tree / "new" / "x.txt"


def test_refuses_a_directory_link_on_the_way_naming_the_operand(tree):
    with pytest.raises(FileNotFoundError) as caught:
        resolve_inside(tree, "/lib64/a.txt", "/data/lib64/a.txt")
    assert str(caught.value) == "/data/lib64/a.txt"


def test_refuses_a_link_out_of_the_root_as_the_leaf(tree):
    with pytest.raises(FileNotFoundError):
        resolve_inside(tree, "/abs", "/abs")


def test_refuses_a_dangling_link(tree):
    with pytest.raises(FileNotFoundError):
        resolve_inside(tree, "/dangling", "/dangling")


def test_still_refuses_a_dotdot_escape(tree):
    with pytest.raises(ValueError, match="escapes root"):
        resolve_inside(tree, "/../escaped", "/../escaped")
