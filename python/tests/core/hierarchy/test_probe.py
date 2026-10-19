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

from mirage.core.hierarchy.probe import file_entry, parent_spec
from mirage.types import FileStat, FileType
from tests.core.hierarchy.conftest import spec


def test_parent_spec_is_the_directory_holding_the_path():
    parent = parent_spec(spec("/rooms/red/a.json"))
    assert (parent.virtual, parent.vfs_path) == ("/h/rooms/red", "rooms/red")


def test_file_entry_answers_a_file_and_refuses_the_rest():
    row = FileStat(name="a.json", type=FileType.FILE)
    assert file_entry(spec("/rooms/red/a.json"), row) is row
    with pytest.raises(IsADirectoryError):
        file_entry(
            spec("/rooms/red"), FileStat(name="red", type=FileType.DIRECTORY)
        )
    with pytest.raises(IsADirectoryError):
        file_entry(spec("/"), None)
    with pytest.raises(FileNotFoundError):
        file_entry(spec("/rooms/red/missing.json"), None)
