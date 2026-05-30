import pytest
from aioresponses import CallbackResult, aioresponses

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.core.onedrive.copy import copy
from mirage.core.onedrive.truncate import truncate
from mirage.types import PathSpec


def _accessor(**kw) -> OneDriveAccessor:
    return OneDriveAccessor(OneDriveConfig(access_token="tok", **kw))


_BASE = "https://graph.microsoft.com/v1.0/me/drive"


@pytest.mark.asyncio
async def test_copy_posts_copy_action_with_name():
    body = {}

    def _cb(url, **kwargs):
        body.update(kwargs.get("json") or {})
        return CallbackResult(status=202, payload={})

    with aioresponses() as m:
        m.post(_BASE + "/root:/a.txt:/copy", callback=_cb)
        await copy(_accessor(), PathSpec.from_str_path("/a.txt"),
                   PathSpec.from_str_path("/sub/b.txt"))
    assert body["name"] == "b.txt"
    assert "/root:/sub" in body["parentReference"]["path"]


@pytest.mark.asyncio
async def test_truncate_shrinks_content():
    captured = {}

    def _put_cb(url, **kwargs):
        captured["body"] = kwargs.get("data")
        return CallbackResult(status=200, payload={"id": "X"})

    content = _BASE + "/root:/a.txt:/content"
    with aioresponses() as m:
        m.get(content, body=b"hello")
        m.put(content, callback=_put_cb)
        await truncate(_accessor(), PathSpec.from_str_path("/a.txt"), 3)
    assert captured["body"] == b"hel"
