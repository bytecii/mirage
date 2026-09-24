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
from collections.abc import AsyncIterator, Mapping, Sequence
from functools import partial
from typing import Any, TypeVar
from urllib.parse import quote, urlencode

import aiohttp

from mirage.accessor.airtable import AirtableAccessor
from mirage.core.api.client import RetryPolicy, api_request
from mirage.core.api.paginate import PageShape, cursor_items, offset_cursor
from mirage.vfs.secrets import reveal_secret

PAGE_SIZE = 100

# Metadata calls (the base listing) are metered per account rather than
# per base; they pace under their own key.
META_KEY = "meta"

NOT_FOUND_TYPES = frozenset({
    "NOT_FOUND",
    "MODEL_ID_NOT_FOUND",
    "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND",
})

# Airtable takes at most ten records in one create, update or delete.
MAX_BATCH = 10

BASES = PageShape(items_key="bases", next_cursor=offset_cursor)
RECORDS = PageShape(items_key="records", next_cursor=offset_cursor)
COMMENTS = PageShape(items_key="comments", next_cursor=offset_cursor)

T = TypeVar("T")


class AirtableAPIError(RuntimeError):
    """A >= 400 answer from the Airtable API.

    Args:
        message (str): the rendered failure, naming the call.
        status (int | None): the HTTP status.
        error_type (str | None): Airtable's error type
            (``AUTHENTICATION_REQUIRED``, ``NOT_FOUND``, ...).
    """

    def __init__(self,
                 message: str,
                 *,
                 status: int | None = None,
                 error_type: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.error_type = error_type

    @property
    def not_found(self) -> bool:
        """Whether the call named something the token cannot see.

        Airtable answers a well-formed id it cannot resolve with a 403,
        not a 404: the permission and the existence checks share one
        answer so a token cannot probe for bases it was not granted.
        """
        return (self.status == 404 or self.error_type in NOT_FOUND_TYPES)


def error_parts(text: str) -> tuple[str | None, str | None]:
    """Airtable's error type and message, from any of its body shapes.

    The API answers ``{"error": {"type", "message"}}``, the same object
    without a message, or a bare ``{"error": "NOT_FOUND"}`` for an
    unmatched route or a malformed id.

    Args:
        text (str): the response body.
    """
    try:
        data = json.loads(text)
    except ValueError:
        return None, None
    if not isinstance(data, dict):
        return None, None
    error = data.get("error")
    if isinstance(error, str):
        return error, None
    if isinstance(error, dict):
        kind = error.get("type")
        message = error.get("message")
        return (kind if isinstance(kind, str) else None,
                message if isinstance(message, str) else None)
    return None, None


def _error_of(resp: aiohttp.ClientResponse, text: str, *,
              call: str) -> Exception:
    kind, message = error_parts(text)
    detail = ": ".join(part for part in (kind, message) if part)
    return AirtableAPIError(
        f"Airtable API error ({call}): HTTP {resp.status}"
        f"{': ' + detail if detail else ''}",
        status=resp.status,
        error_type=kind,
    )


def _retryable(status: int, text: str) -> bool:
    # A 429 means either "slow down" (RATE_LIMIT_REACHED) or "this
    # workspace spent its monthly calls"; waiting only helps the first.
    kind, _ = error_parts(text)
    return kind != "PUBLIC_API_BILLING_LIMIT_EXCEEDED"


# After a 429 Airtable refuses every request to the base for 30 seconds,
# so a retry sooner than that is spent inside the penalty; 502 and 503
# are documented as safe to retry with backoff.
RETRY = RetryPolicy(
    statuses=frozenset({429, 502, 503}),
    max_retries=2,
    max_backoff=30.0,
    retryable=_retryable,
    min_delays={429: 30.0},
)

# A write retries only the 429, which Airtable answers before it applies
# anything. A 502 or 503 may come back after the records landed, and a
# retried create would make them twice.
WRITE_RETRY = RetryPolicy(
    statuses=frozenset({429}),
    max_retries=2,
    max_backoff=30.0,
    retryable=_retryable,
    min_delays={429: 30.0},
)


def _headers(accessor: AirtableAccessor) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {reveal_secret(accessor.config.token)}",
    }


async def _request(accessor: AirtableAccessor,
                   method: str,
                   path: str,
                   *,
                   pace_key: str,
                   params: Mapping[str, str | int] | None = None,
                   query: str = "",
                   json_body: dict[str, Any] | None = None,
                   retry: RetryPolicy = RETRY) -> Any:
    await accessor.limiter.acquire(pace_key)
    url = f"{accessor.config.base_url}{path}"
    return await api_request(method,
                             f"{url}?{query}" if query else url,
                             error_of=partial(_error_of,
                                              call=f"{method} {path}"),
                             headers=_headers(accessor),
                             params=params,
                             json_body=json_body,
                             retry=retry,
                             session=accessor.pool)


async def _get(accessor: AirtableAccessor, path: str, *,
               params: Mapping[str, str | int] | None, pace_key: str) -> Any:
    return await _request(accessor,
                          "GET",
                          path,
                          pace_key=pace_key,
                          params=params)


def _segment(value: str) -> str:
    return quote(value, safe="")


def _table_path(base_id: str, table: str) -> str:
    return f"/{_segment(base_id)}/{_segment(table)}"


def _batches(items: Sequence[T]) -> list[Sequence[T]]:
    return [
        items[start:start + MAX_BATCH]
        for start in range(0, len(items), MAX_BATCH)
    ]


def _records_of(data: Any) -> list[dict[str, Any]]:
    rows = data.get("records") if isinstance(data, dict) else None
    return [r for r in rows
            if isinstance(r, dict)] if isinstance(rows, list) else []


async def _bases_page(accessor: AirtableAccessor,
                      cursor: str | None) -> dict[str, Any]:
    params: dict[str, str | int] | None = ({
        "offset": cursor
    } if cursor else None)
    data = await _get(accessor,
                      "/meta/bases",
                      params=params,
                      pace_key=META_KEY)
    return data if isinstance(data, dict) else {}


async def list_bases(accessor: AirtableAccessor) -> list[dict[str, Any]]:
    """Every base the token reaches, narrowed to ``config.base_ids``.

    Args:
        accessor (AirtableAccessor): the account.
    """
    bases = await cursor_items(partial(_bases_page, accessor), shape=BASES)
    wanted = accessor.config.base_ids
    return [
        base for base in bases if isinstance(base, dict) and (
            wanted is None or base.get("id") in wanted)
    ]


async def list_tables(accessor: AirtableAccessor,
                      base_id: str) -> list[dict[str, Any]]:
    """A base's schema: its tables with their fields and views.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
    """
    data = await _get(accessor,
                      f"/meta/bases/{_segment(base_id)}/tables",
                      params=None,
                      pace_key=base_id)
    tables = data.get("tables") if isinstance(data, dict) else None
    return [t for t in tables
            if isinstance(t, dict)] if isinstance(tables, list) else []


async def _page(accessor: AirtableAccessor, base_id: str, path: str,
                params: dict[str,
                             str | int], cursor: str | None) -> dict[str, Any]:
    query = {**params, "offset": cursor} if cursor else params
    data = await _get(accessor, path, params=query, pace_key=base_id)
    return data if isinstance(data, dict) else {}


async def list_records(accessor: AirtableAccessor,
                       base_id: str,
                       table_id: str,
                       *,
                       view: str | None = None,
                       formula: str | None = None,
                       max_records: int | None = None) -> list[dict[str, Any]]:
    """A table's records in the API's order, or a view's.

    Without a view Airtable calls the order arbitrary; it is the order
    the table hands out, stable between calls, and the only one a
    ``maxRecords`` prefix agrees with.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
        table_id (str): the table, by id or by name.
        view (str | None): a view, by id or by name; its filter and
            order apply.
        formula (str | None): an Airtable formula (``filterByFormula``);
            only the records it is true for are listed.
        max_records (int | None): stop after this many records, both on
            the wire (``maxRecords``) and in the collector.
    """
    params: dict[str, str | int] = {"pageSize": PAGE_SIZE}
    if view is not None:
        params["view"] = view
    if formula is not None:
        params["filterByFormula"] = formula
    if max_records is not None:
        params["maxRecords"] = max_records
    records = await cursor_items(partial(_page, accessor, base_id,
                                         _table_path(base_id, table_id),
                                         params),
                                 max_results=max_records,
                                 shape=RECORDS)
    return [r for r in records if isinstance(r, dict)]


async def get_record(accessor: AirtableAccessor, base_id: str, table_id: str,
                     record_id: str) -> dict[str, Any]:
    """One record by id.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
        table_id (str): the table, by id or by name.
        record_id (str): the record.
    """
    data = await _get(
        accessor,
        f"{_table_path(base_id, table_id)}/{_segment(record_id)}",
        params=None,
        pace_key=base_id)
    return data if isinstance(data, dict) else {}


async def create_records(
        accessor: AirtableAccessor,
        base_id: str,
        table_id: str,
        records: Sequence[dict[str, Any]],
        *,
        typecast: bool = False) -> AsyncIterator[list[dict[str, Any]]]:
    """Create records ten to a request, yielding each request's records.

    A request that fails raises after every earlier one landed, so the
    caller holds exactly what was written.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
        table_id (str): the table, by id or by name.
        records (Sequence[dict[str, Any]]): each new record's cell map,
            keyed by field name.
        typecast (bool): let Airtable convert string values to the
            field types (``typecast``).
    """
    path = _table_path(base_id, table_id)
    for batch in _batches(records):
        body: dict[str, Any] = {"records": [{"fields": f} for f in batch]}
        if typecast:
            body["typecast"] = True
        data = await _request(accessor,
                              "POST",
                              path,
                              pace_key=base_id,
                              json_body=body,
                              retry=WRITE_RETRY)
        yield _records_of(data)


async def update_records(
        accessor: AirtableAccessor,
        base_id: str,
        table_id: str,
        updates: Sequence[tuple[str, dict[str, Any]]],
        *,
        typecast: bool = False) -> AsyncIterator[list[dict[str, Any]]]:
    """Patch records ten to a request, yielding each request's records.

    A PATCH, never a PUT: a cell the update leaves out keeps its value.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
        table_id (str): the table, by id or by name.
        updates (Sequence[tuple[str, dict[str, Any]]]): record id and the
            cells to change, keyed by field name.
        typecast (bool): let Airtable convert string values to the
            field types (``typecast``).
    """
    path = _table_path(base_id, table_id)
    for batch in _batches(updates):
        body: dict[str, Any] = {
            "records": [{
                "id": record_id,
                "fields": fields
            } for record_id, fields in batch]
        }
        if typecast:
            body["typecast"] = True
        data = await _request(accessor,
                              "PATCH",
                              path,
                              pace_key=base_id,
                              json_body=body,
                              retry=WRITE_RETRY)
        yield _records_of(data)


async def delete_records(
        accessor: AirtableAccessor, base_id: str, table_id: str,
        record_ids: Sequence[str]) -> AsyncIterator[list[dict[str, Any]]]:
    """Delete records ten to a request, yielding each request's answer.

    The ids ride the query string as ``records[]``, which is the only
    place the endpoint reads them from.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
        table_id (str): the table, by id or by name.
        record_ids (Sequence[str]): the records to delete.
    """
    path = _table_path(base_id, table_id)
    for batch in _batches(record_ids):
        data = await _request(accessor,
                              "DELETE",
                              path,
                              pace_key=base_id,
                              query=urlencode([("records[]", record_id)
                                               for record_id in batch]),
                              retry=WRITE_RETRY)
        yield _records_of(data)


async def list_comments(accessor: AirtableAccessor, base_id: str,
                        table_id: str, record_id: str) -> list[dict[str, Any]]:
    """A record's comments in the API's order, newest first.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
        table_id (str): the table, by id or by name.
        record_id (str): the record.
    """
    path = (f"{_table_path(base_id, table_id)}/{_segment(record_id)}"
            "/comments")
    comments = await cursor_items(partial(_page, accessor, base_id, path,
                                          {"pageSize": PAGE_SIZE}),
                                  shape=COMMENTS)
    return [c for c in comments if isinstance(c, dict)]


async def create_comment(accessor: AirtableAccessor, base_id: str,
                         table_id: str, record_id: str,
                         text: str) -> dict[str, Any]:
    """Comment on a record as the token's user.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
        table_id (str): the table, by id or by name.
        record_id (str): the record.
        text (str): the comment text.
    """
    data = await _request(
        accessor,
        "POST",
        f"{_table_path(base_id, table_id)}/{_segment(record_id)}/comments",
        pace_key=base_id,
        json_body={"text": text},
        retry=WRITE_RETRY)
    return data if isinstance(data, dict) else {}
