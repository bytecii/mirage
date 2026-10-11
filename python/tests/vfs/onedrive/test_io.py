from unittest.mock import AsyncMock, patch

import pytest

import mirage.core.msgraph.client as graph_client
from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.msgraph.client import GraphError
from mirage.types import PathSpec
from mirage.vfs.onedrive import OneDriveVFS
from tests.fixtures.vfs_io import vfs_over

_BASE = "https://graph.microsoft.com/v1.0/me/drive"
_TREE = {
    _BASE + "/root": {"id": "root", "folder": {"childCount": 2}},
    _BASE + "/root/children": {
        "value": [
            {"id": "1", "name": "a.txt", "size": 3, "file": {}},
            {
                "id": "2",
                "name": "sub",
                "size": 99,
                "folder": {"childCount": 1},
            },
        ]
    },
    _BASE + "/root:/sub:/children": {
        "value": [{"id": "3", "name": "b.txt", "size": 5, "file": {}}]
    },
}


@pytest.fixture
def seen(monkeypatch) -> list[str]:
    urls: list[str] = []

    async def _request(config, method, url, **kwargs):
        urls.append(url)
        if url not in _TREE:
            raise GraphError(404, "itemNotFound", url)
        return _TREE[url]

    monkeypatch.setattr(graph_client, "_request", _request)
    return urls


def _accessor() -> OneDriveAccessor:
    return OneDriveAccessor(OneDriveConfig(access_token="tok"))


@pytest.mark.asyncio
async def test_du_walks_one_list_per_folder_with_file_sizes_only(seen):
    entries, total = await vfs_over(OneDriveVFS, _accessor()).du_entries(
        PathSpec.from_str_path("/od", ""), RAMIndexCacheStore()
    )
    assert entries == [("/a.txt", 3), ("/sub/b.txt", 5)]
    assert total == 8
    assert seen == [
        _BASE + "/root",
        _BASE + "/root",
        _BASE + "/root/children",
        _BASE + "/root:/sub:/children",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "content_search, whole_word, asked",
    [(False, True, False), (True, False, False), (True, True, True)],
)
async def test_files_containing_needs_content_search_and_a_whole_word(
    content_search, whole_word, asked
):
    vfs = OneDriveVFS(
        OneDriveConfig(access_token="tok", content_search=content_search)
    )
    with patch(
        "mirage.vfs.onedrive.onedrive._files_containing",
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
