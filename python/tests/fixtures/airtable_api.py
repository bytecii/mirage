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

import inspect
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest
from aiohttp import ClientResponse
from aioresponses import CallbackResult, aioresponses
from aioresponses import core as aioresponses_core

from mirage.accessor.airtable import AirtableAccessor
from mirage.core.airtable.config import AirtableConfig


class _PatchedClientResponse(ClientResponse):

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        kwargs.setdefault("stream_writer", SimpleNamespace(output_size=0))
        super().__init__(*args, **kwargs)


if "stream_writer" in inspect.signature(ClientResponse.__init__).parameters:
    aioresponses_core.ClientResponse = _PatchedClientResponse

API = "https://api.airtable.com/v0"
TOKEN = "patTest0000000001.secret"
ROADMAP = "appRoadmapBase001"
OPS = "appOpsFinance0001"
FEATURES = "tblFeatures000001"
BUDGET = "tblBudget00000001"
GRID = "viwGrid0000000001"
DONE = "viwDone0000000001"
VIEW_ID = re.compile(r"viw[A-Za-z0-9]{14}")


def _record(n: int, **fields: Any) -> dict[str, Any]:
    return {
        "id": f"rec{n:014d}",
        "createdTime": f"2026-01-{n:02d}T09:00:00.000Z",
        "fields": fields,
    }


def _features() -> list[dict[str, Any]]:
    rows = []
    for n in range(1, 8):
        cells: dict[str, Any] = {"Name": f"Feature {n}", "Priority": n}
        if n % 2:
            cells["Status"] = "Done"
        rows.append(_record(n, **cells))
    return rows


def _is_done(record: dict[str, Any]) -> bool:
    return record["fields"].get("Status") == "Done"


def _error(status: int, kind: str, message: str | None = None) -> Any:
    body: dict[str, Any] = {"type": kind}
    if message is not None:
        body["message"] = message
    return CallbackResult(status=status, payload={"error": body})


@dataclass
class FakeAirtable:
    """An in-process Airtable API for aioresponses, paged like the real one.

    ``page_cap`` keeps pages short so a handful of records still spans
    several ``offset`` round trips.
    """

    bases: list[dict[str, Any]] = field(default_factory=lambda: [
        {
            "id": ROADMAP,
            "name": "Product Roadmap",
            "permissionLevel": "create"
        },
        {
            "id": OPS,
            "name": "Ops / Finance ✓",
            "permissionLevel": "read"
        },
    ])
    tables: dict[str, list[dict[str, Any]]] = field(
        default_factory=lambda: {
            ROADMAP: [{
                "id":
                FEATURES,
                "name":
                "Features",
                "primaryFieldId":
                "fldName000000001",
                "fields": [
                    {
                        "id": "fldName000000001",
                        "name": "Name",
                        "type": "singleLineText"
                    },
                    {
                        "id": "fldStatus0000001",
                        "name": "Status",
                        "type": "singleSelect",
                        "options": {
                            "choices": [{
                                "id": "selDone000000001",
                                "name": "Done"
                            }]
                        },
                    },
                    {
                        "id": "fldPriority00001",
                        "name": "Priority",
                        "type": "number",
                        "options": {
                            "precision": 0
                        }
                    },
                ],
                "views": [
                    {
                        "id": GRID,
                        "name": "Grid view",
                        "type": "grid"
                    },
                    {
                        "id": DONE,
                        "name": "Done / shipped",
                        "type": "grid"
                    },
                ],
            }],
            OPS: [{
                "id":
                BUDGET,
                "name":
                "Q3 / Budget",
                "primaryFieldId":
                "fldLine000000001",
                "fields": [{
                    "id": "fldLine000000001",
                    "name": "Line",
                    "type": "singleLineText"
                }],
                "views": [],
            }],
        })
    records: dict[str,
                  list[dict[str,
                            Any]]] = field(default_factory=lambda: {
                                FEATURES: _features(),
                                BUDGET: [_record(1, Line="Rent")],
                            })
    views: dict[str, Callable[[dict[str, Any]],
                              bool]] = field(default_factory=lambda: {
                                  GRID: lambda record: True,
                                  DONE: _is_done
                              })
    page_cap: int = 3
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)

    def _authorized(self, kwargs: dict[str, Any]) -> bool:
        headers = kwargs.get("headers") or {}
        return headers.get("Authorization") == f"Bearer {TOKEN}"

    def _bases(self, url: Any, **kwargs: Any) -> Any:
        self.calls.append(("bases", dict(kwargs.get("params") or {})))
        if not self._authorized(kwargs):
            return _error(401, "AUTHENTICATION_REQUIRED",
                          "Authentication required")
        return CallbackResult(payload={"bases": self.bases})

    def _tables(self, url: Any, **kwargs: Any) -> Any:
        base_id = str(url).split("/meta/bases/")[1].split("/")[0]
        self.calls.append(("tables", {"base": base_id}))
        if base_id not in self.tables:
            return _error(403, "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND")
        return CallbackResult(payload={"tables": self.tables[base_id]})

    def _records(self, url: Any, **kwargs: Any) -> Any:
        params = {k: str(v) for k, v in (kwargs.get("params") or {}).items()}
        tail = str(url).split(API + "/")[1].split("?")[0]
        base_id, table_id = tail.split("/")
        self.calls.append(("records", {**params, "table": table_id}))
        table_ids = {t["id"] for t in self.tables.get(base_id, [])}
        if table_id not in table_ids:
            return _error(403, "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND")
        pool = self.records[table_id]
        view = params.get("view")
        if view is not None:
            keep = self.views.get(view)
            if keep is None:
                kind = ("VIEW_ID_NOT_FOUND"
                        if VIEW_ID.fullmatch(view) else "VIEW_NAME_NOT_FOUND")
                return _error(422, kind, f"View {view} not found")
            pool = [r for r in pool if keep(r)]
        if "maxRecords" in params:
            pool = pool[:int(params["maxRecords"])]
        size = min(int(params.get("pageSize", 100)), self.page_cap)
        start = int(
            params["offset"].split("/")[1]) if "offset" in params else 0
        body: dict[str, Any] = {"records": pool[start:start + size]}
        if start + size < len(pool):
            body["offset"] = f"itrFakeIterator01/{start + size}"
        return CallbackResult(payload=body)

    def install(self, m: aioresponses) -> None:
        """Route the API's read endpoints to this fake.

        Args:
            m (aioresponses): the active mock.
        """
        m.get(re.compile(rf"^{re.escape(API)}/meta/bases(\?.*)?$"),
              callback=self._bases,
              repeat=True)
        m.get(re.compile(rf"^{re.escape(API)}/meta/bases/[^/]+/tables$"),
              callback=self._tables,
              repeat=True)
        m.get(re.compile(rf"^{re.escape(API)}/app\w+/[^/?]+(\?.*)?$"),
              callback=self._records,
              repeat=True)

    def record_calls(self) -> list[dict[str, Any]]:
        """The query of every records request, in order."""
        return [params for kind, params in self.calls if kind == "records"]


@pytest.fixture
def airtable_api() -> Iterator[FakeAirtable]:
    fake = FakeAirtable()
    with aioresponses() as m:
        fake.install(m)
        yield fake


def make_accessor(**overrides: Any) -> AirtableAccessor:
    """An accessor against the fake, pacing disabled for speed.

    Args:
        **overrides (Any): AirtableConfig fields to replace.
    """
    config = AirtableConfig(**{
        "token": TOKEN,
        "requests_per_second": 10_000.0,
        **overrides
    })
    return AirtableAccessor(config)
