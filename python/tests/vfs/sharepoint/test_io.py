from unittest.mock import AsyncMock, patch

import pytest

import mirage.core.msgraph.client as graph_client
from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.cache.index import RAMIndexCacheStore
from mirage.types import PathSpec
from mirage.vfs.sharepoint import SharePointVFS
from tests.fixtures.vfs_io import vfs_over

_API = "https://graph.microsoft.com/v1.0"
_GRAPH = {
    f"{_API}/sites": {"value": [{"id": "site-id", "displayName": "Team"}]},
    f"{_API}/sites/site-id/drives": {
        "value": [{"id": "drive-id", "name": "Documents"}]
    },
    f"{_API}/drives/drive-id/root/children": {
        "value": [
            {"id": "1", "name": "a.txt", "size": 3, "file": {}},
            {"id": "2", "name": "b.txt", "size": 4, "file": {}},
        ]
    },
}


@pytest.mark.asyncio
@pytest.mark.parametrize("key", ["", "Team", "Team/Documents"])
async def test_du_walks_the_namespace_levels(monkeypatch, key):
    # An unscoped mount's root and site levels are directories like any
    # other, so du sums every library under them, one list per level.
    seen: list[str] = []

    async def _request(config, method, url, **kwargs):
        seen.append(url)
        return _GRAPH[url]

    monkeypatch.setattr(graph_client, "_request", _request)
    accessor = SharePointAccessor(SharePointConfig(access_token="tok"))
    path = PathSpec.from_str_path("/sp/" + key if key else "/sp", key)
    assert (
        await vfs_over(SharePointVFS, accessor).du_size(
            path, RAMIndexCacheStore()
        )
        == 7
    )
    assert seen == list(_GRAPH)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "content_search, whole_word, asked",
    [(False, True, False), (True, False, False), (True, True, True)],
)
async def test_files_containing_needs_content_search_and_a_whole_word(
    content_search, whole_word, asked
):
    vfs = SharePointVFS(
        SharePointConfig(access_token="tok", content_search=content_search)
    )
    with patch(
        "mirage.vfs.sharepoint.sharepoint._files_containing",
        new_callable=AsyncMock,
        return_value=None,
    ) as spy:
        await vfs.files_containing(
            "wombat",
            [PathSpec.from_str_path("/m", "")],
            whole_word=whole_word,
            ignore_case=False,
        )
    assert spy.await_count == (1 if asked else 0)
