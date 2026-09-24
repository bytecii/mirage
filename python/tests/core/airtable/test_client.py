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

from mirage.core.airtable.client import (RETRY, AirtableAPIError, error_parts,
                                         list_bases, list_records, list_tables)
from tests.fixtures.airtable_api import FEATURES, OPS, ROADMAP, make_accessor


def test_error_parts_reads_every_body_shape():
    assert error_parts('{"error": {"type": "X", "message": "m"}}') == ("X",
                                                                       "m")
    assert error_parts(
        '{"error": {"type": "LIST_RECORDS_ITERATOR_NOT_'
        'AVAILABLE"}}') == ("LIST_RECORDS_ITERATOR_NOT_AVAILABLE", None)
    assert error_parts('{"error": "NOT_FOUND"}') == ("NOT_FOUND", None)
    assert error_parts("not json") == (None, None)
    assert error_parts("[1]") == (None, None)


def test_the_retry_policy_vetoes_only_the_billing_cap():
    assert RETRY.retryable is not None
    assert RETRY.retryable(429, '{"error": {"type": "RATE_LIMIT_REACHED"}}')
    assert not RETRY.retryable(
        429, '{"error": {"type": "PUBLIC_API_BILLING_LIMIT_EXCEEDED"}}')
    assert RETRY.min_delays[429] == 30.0


def test_not_found_covers_airtables_403_answer():
    assert AirtableAPIError("m", status=404).not_found
    assert AirtableAPIError(
        "m", status=403,
        error_type="INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND").not_found
    assert not AirtableAPIError("m", status=422,
                                error_type="INVALID_REQUEST").not_found


@pytest.mark.asyncio
async def test_list_bases_honors_the_configured_scope(airtable_api):
    everything = await list_bases(make_accessor())
    assert [b["id"] for b in everything] == [ROADMAP, OPS]
    scoped = await list_bases(make_accessor(base_ids=[OPS]))
    assert [b["id"] for b in scoped] == [OPS]


@pytest.mark.asyncio
async def test_a_bad_token_names_the_call_and_the_type(airtable_api):
    with pytest.raises(AirtableAPIError) as exc:
        await list_bases(make_accessor(token="wrong"))
    assert exc.value.status == 401
    assert exc.value.error_type == "AUTHENTICATION_REQUIRED"
    assert str(
        exc.value) == ("Airtable API error (GET /meta/bases): HTTP 401: "
                       "AUTHENTICATION_REQUIRED: Authentication required")


@pytest.mark.asyncio
async def test_list_tables_returns_the_schema(airtable_api):
    tables = await list_tables(make_accessor(), ROADMAP)
    assert [t["id"] for t in tables] == [FEATURES]


@pytest.mark.asyncio
async def test_list_records_pages_through_every_offset(airtable_api):
    records = await list_records(make_accessor(), ROADMAP, FEATURES)
    assert len(records) == 7
    calls = airtable_api.record_calls()
    assert len(calls) == 3
    assert "offset" not in calls[0]
    assert calls[1]["offset"] == "itrFakeIterator01/3"
    assert all(c["pageSize"] == "100" for c in calls)


@pytest.mark.asyncio
async def test_max_records_rides_the_wire_and_the_collector(airtable_api):
    records = await list_records(make_accessor(),
                                 ROADMAP,
                                 FEATURES,
                                 max_records=2)
    assert [r["id"]
            for r in records] == ["rec00000000000001", "rec00000000000002"]
    assert airtable_api.record_calls()[0]["maxRecords"] == "2"


@pytest.mark.asyncio
async def test_a_view_filters_through_the_api(airtable_api):
    records = await list_records(make_accessor(),
                                 ROADMAP,
                                 FEATURES,
                                 view="viwDone0000000001")
    assert [r["fields"]["Priority"] for r in records] == [1, 3, 5, 7]
