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

from mirage.vfs.airtable.prompt import PROMPT


def test_prompt_maps_every_file_and_the_record_shape():
    rendered = PROMPT.replace("{prefix}", "/airtable")
    for name in ("base.json", "table.json", "records.jsonl", "views/"):
        assert name in rendered
    assert "record_id, created_time, and fields" in rendered
    assert "max_read_records" in rendered
    assert "head -n 20 /airtable/bases/" in rendered
    assert "{" not in rendered and "}" not in rendered
