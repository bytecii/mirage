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

from urllib.parse import quote

import aiohttp

from mirage.accessor.onedrive import OneDriveConfig
from mirage.resource.secrets import reveal_secret
from mirage.types import PathSpec

GRAPH_API = "https://graph.microsoft.com/v1.0"


def split_path(path: PathSpec | str) -> tuple[str, str]:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    prefix = path.prefix or ""
    raw = path.original
    if prefix and raw.startswith(prefix):
        raw = raw[len(prefix):] or "/"
    return prefix, raw.strip("/")


class GraphError(RuntimeError):

    def __init__(self, status: int, code: str, message: str) -> None:
        self.status = status
        self.code = code
        super().__init__(f"Graph API error {status} ({code}): {message}")


def drive_base(config: OneDriveConfig) -> str:
    if config.drive_id:
        return f"{GRAPH_API}/drives/{config.drive_id}"
    if config.site_id:
        return f"{GRAPH_API}/sites/{config.site_id}/drive"
    return f"{GRAPH_API}/me/drive"


def _full_path(config: OneDriveConfig, path: str) -> str:
    p = path.strip("/")
    prefix = (config.key_prefix or "").strip("/")
    if prefix and p:
        return f"{prefix}/{p}"
    return prefix or p


def item_url(config: OneDriveConfig, path: str, action: str = "") -> str:
    base = drive_base(config)
    full = _full_path(config, path)
    if not full:
        return f"{base}/root{action}"
    stem = f"{base}/root:/{quote(full, safe='/')}"
    if action:
        return f"{stem}:{action}"
    return stem


def drive_ref_path(config: OneDriveConfig, folder: str = "") -> str:
    base = drive_base(config)[len(GRAPH_API):]
    if folder:
        return f"{base}/root:/{quote(folder, safe='/')}"
    return f"{base}/root:"


def headers(config: OneDriveConfig) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {reveal_secret(config.access_token)}",
        "Content-Type": "application/json",
    }


def _timeout(config: OneDriveConfig) -> aiohttp.ClientTimeout:
    return aiohttp.ClientTimeout(total=config.timeout)


async def _raise_for_status(method: str, url: str,
                            resp: aiohttp.ClientResponse) -> None:
    if resp.status < 400:
        return
    try:
        data = await resp.json()
        err = data.get("error", {}) if isinstance(data, dict) else {}
    except (aiohttp.ContentTypeError, ValueError):
        err = {}
    raise GraphError(resp.status, err.get("code", "unknownError"),
                     err.get("message", f"{method} {url}"))


async def graph_get(config: OneDriveConfig,
                    url: str,
                    params: dict | None = None) -> dict:
    async with aiohttp.ClientSession(timeout=_timeout(config)) as session:
        async with session.get(url, headers=headers(config),
                               params=params) as resp:
            await _raise_for_status("GET", url, resp)
            return await resp.json()


async def graph_list(config: OneDriveConfig,
                     url: str,
                     params: dict | None = None) -> list[dict]:
    items: list[dict] = []
    next_url: str | None = url
    next_params = params
    async with aiohttp.ClientSession(timeout=_timeout(config)) as session:
        while next_url:
            async with session.get(next_url,
                                   headers=headers(config),
                                   params=next_params) as resp:
                await _raise_for_status("GET", next_url, resp)
                data = await resp.json()
            items.extend(data.get("value", []))
            next_url = data.get("@odata.nextLink")
            next_params = None
    return items


async def graph_get_bytes(config: OneDriveConfig,
                          url: str,
                          range_header: str | None = None) -> bytes:
    hdrs = headers(config)
    if range_header:
        hdrs["Range"] = range_header
    async with aiohttp.ClientSession(timeout=_timeout(config)) as session:
        async with session.get(url, headers=hdrs) as resp:
            await _raise_for_status("GET", url, resp)
            return await resp.read()


async def graph_stream(config: OneDriveConfig,
                       url: str,
                       chunk_size: int = 8192):
    async with aiohttp.ClientSession(timeout=_timeout(config)) as session:
        async with session.get(url, headers=headers(config)) as resp:
            await _raise_for_status("GET", url, resp)
            async for chunk in resp.content.iter_chunked(chunk_size):
                yield chunk


async def graph_post(config: OneDriveConfig,
                     url: str,
                     body: dict | None = None) -> dict:
    async with aiohttp.ClientSession(timeout=_timeout(config)) as session:
        async with session.post(url, headers=headers(config), json=body
                                or {}) as resp:
            await _raise_for_status("POST", url, resp)
            return await resp.json()


async def graph_patch(config: OneDriveConfig, url: str, body: dict) -> dict:
    async with aiohttp.ClientSession(timeout=_timeout(config)) as session:
        async with session.patch(url, headers=headers(config),
                                 json=body) as resp:
            await _raise_for_status("PATCH", url, resp)
            return await resp.json()


async def graph_delete(config: OneDriveConfig, url: str) -> None:
    async with aiohttp.ClientSession(timeout=_timeout(config)) as session:
        async with session.delete(url, headers=headers(config)) as resp:
            await _raise_for_status("DELETE", url, resp)


async def graph_put_bytes(
        config: OneDriveConfig,
        url: str,
        data: bytes,
        content_type: str = "application/octet-stream") -> dict:
    hdrs = headers(config)
    hdrs["Content-Type"] = content_type
    async with aiohttp.ClientSession(timeout=_timeout(config)) as session:
        async with session.put(url, headers=hdrs, data=data) as resp:
            await _raise_for_status("PUT", url, resp)
            return await resp.json()


async def upload_chunk(config: OneDriveConfig, upload_url: str, data: bytes,
                       start: int, total: int) -> int:
    end = start + len(data) - 1
    hdrs = {"Content-Range": f"bytes {start}-{end}/{total}"}
    async with aiohttp.ClientSession(timeout=_timeout(config)) as session:
        async with session.put(upload_url, headers=hdrs, data=data) as resp:
            await _raise_for_status("PUT", upload_url, resp)
            return resp.status
