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
from functools import partial
from typing import Any
from urllib.parse import quote

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

BASES = PageShape(items_key="bases", next_cursor=offset_cursor)
RECORDS = PageShape(items_key="records", next_cursor=offset_cursor)


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


def _headers(accessor: AirtableAccessor) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {reveal_secret(accessor.config.token)}",
    }


async def _get(accessor: AirtableAccessor, path: str, *,
               params: dict[str, str | int] | None, pace_key: str) -> Any:
    await accessor.limiter.acquire(pace_key)
    return await api_request("GET",
                             f"{accessor.config.base_url}{path}",
                             error_of=partial(_error_of, call=f"GET {path}"),
                             headers=_headers(accessor),
                             params=params,
                             retry=RETRY,
                             session=accessor.pool)


def _segment(value: str) -> str:
    return quote(value, safe="")


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


async def _records_page(accessor: AirtableAccessor, base_id: str,
                        table_id: str, params: dict[str, str | int],
                        cursor: str | None) -> dict[str, Any]:
    query = {**params, "offset": cursor} if cursor else params
    data = await _get(accessor,
                      f"/{_segment(base_id)}/{_segment(table_id)}",
                      params=query,
                      pace_key=base_id)
    return data if isinstance(data, dict) else {}


async def list_records(accessor: AirtableAccessor,
                       base_id: str,
                       table_id: str,
                       *,
                       view: str | None = None,
                       max_records: int | None = None) -> list[dict[str, Any]]:
    """A table's records in the API's order, or a view's.

    Without a view Airtable calls the order arbitrary; it is the order
    the table hands out, stable between calls, and the only one a
    ``maxRecords`` prefix agrees with.

    Args:
        accessor (AirtableAccessor): the account.
        base_id (str): the base.
        table_id (str): the table.
        view (str | None): a view id; its filter and order apply.
        max_records (int | None): stop after this many records, both on
            the wire (``maxRecords``) and in the collector.
    """
    params: dict[str, str | int] = {"pageSize": PAGE_SIZE}
    if view is not None:
        params["view"] = view
    if max_records is not None:
        params["maxRecords"] = max_records
    records = await cursor_items(partial(_records_page, accessor, base_id,
                                         table_id, params),
                                 max_results=max_records,
                                 shape=RECORDS)
    return [r for r in records if isinstance(r, dict)]
