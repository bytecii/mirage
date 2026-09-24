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

import json

from mirage.core.airtable.normalize import (normalize_base, normalize_record,
                                            normalize_table, records_jsonl)


def test_base_json_lists_its_tables():
    base = {"id": "appA", "name": "A", "permissionLevel": "read"}
    tables = [{"id": "tblT", "name": "T", "primaryFieldId": "fldP"}]
    assert normalize_base(base, tables) == {
        "base_id":
        "appA",
        "base_name":
        "A",
        "permission_level":
        "read",
        "tables": [{
            "table_id": "tblT",
            "table_name": "T",
            "primary_field_id": "fldP"
        }],
    }


def test_table_json_keeps_field_types_and_options():
    table = {
        "id":
        "tblT",
        "name":
        "T",
        "primaryFieldId":
        "fldP",
        "fields": [{
            "id": "fldP",
            "name": "Name",
            "type": "singleLineText"
        }, {
            "id": "fldS",
            "name": "Status",
            "type": "singleSelect",
            "options": {
                "choices": []
            }
        }],
        "views": [{
            "id": "viwG",
            "name": "Grid view",
            "type": "grid"
        }],
    }
    out = normalize_table(table, "appA")
    assert out["base_id"] == "appA"
    assert out["fields"][1] == {
        "field_id": "fldS",
        "field_name": "Status",
        "type": "singleSelect",
        "description": None,
        "options": {
            "choices": []
        },
    }
    assert out["views"] == [{
        "view_id": "viwG",
        "view_name": "Grid view",
        "type": "grid"
    }]


def test_a_record_passes_its_cells_through():
    record = {
        "id": "recA",
        "createdTime": "2026-01-01T00:00:00.000Z",
        "fields": {
            "Name": "é",
            "Link": ["recB"]
        }
    }
    assert normalize_record(record) == {
        "record_id": "recA",
        "created_time": "2026-01-01T00:00:00.000Z",
        "fields": {
            "Name": "é",
            "Link": ["recB"]
        },
    }
    assert normalize_record({"id": "recC"})["fields"] == {}


def test_records_render_one_line_each_in_listing_order():
    rows = records_jsonl([{
        "id": "rec2",
        "fields": {
            "Notes": "a\nb"
        }
    }, {
        "id": "rec1",
        "fields": {}
    }])
    lines = rows.decode().splitlines()
    assert [json.loads(line)["record_id"]
            for line in lines] == ["rec2", "rec1"]
    assert records_jsonl([]) == b""
