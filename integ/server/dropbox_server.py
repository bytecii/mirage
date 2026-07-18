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

from aiohttp import web

MODIFIED = "2026-01-02T00:00:00Z"


class FakeDropbox:
    """One fake Dropbox account: seeded files, folders implied by paths.

    Serves the three endpoints the backend calls — /oauth2/token,
    /2/files/list_folder, /2/files/download — on a single origin,
    matching the DropboxConfig ``endpoint`` override. Mirrors the TS
    fake in integ/server/dropbox.ts.
    """

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.endpoint = ""

    def seed(self, path: str, content: bytes) -> None:
        self.files[path] = content

    def _folders(self) -> set[str]:
        folders: set[str] = set()
        for path in self.files:
            parts = path.split("/")[1:-1]
            cur = ""
            for part in parts:
                cur += f"/{part}"
                folders.add(cur)
        return folders

    def _list_children(self, path: str) -> list[dict] | None:
        folders = self._folders()
        if path and path not in folders:
            return None
        out: list[dict] = []
        for folder in folders:
            if folder.rsplit("/", 1)[0] != path:
                continue
            out.append({
                ".tag": "folder",
                "id": f"id:{folder}",
                "name": folder.rsplit("/", 1)[1],
                "path_lower": folder.lower(),
                "path_display": folder,
            })
        for file, content in self.files.items():
            if file.rsplit("/", 1)[0] != path:
                continue
            out.append({
                ".tag": "file",
                "id": f"id:{file}",
                "name": file.rsplit("/", 1)[1],
                "path_lower": file.lower(),
                "path_display": file,
                "size": len(content),
                "server_modified": MODIFIED,
            })
        return sorted(out, key=lambda e: e["name"])

    async def handle_token(self, request: web.Request) -> web.Response:
        return web.json_response({
            "access_token": "integ-token",
            "expires_in": 14400,
        })

    async def handle_list_folder(self, request: web.Request) -> web.Response:
        body = await request.json()
        entries = self._list_children(body.get("path") or "")
        if entries is None:
            return web.json_response({"error_summary": "path/not_found/..."},
                                     status=409)
        return web.json_response({
            "entries": entries,
            "cursor": "cursor-0",
            "has_more": False,
        })

    async def handle_download(self, request: web.Request) -> web.Response:
        arg = json.loads(request.headers.get("Dropbox-API-Arg", "{}"))
        content = self.files.get(arg.get("path") or "")
        if content is None:
            return web.json_response({"error_summary": "path/not_found/..."},
                                     status=409)
        return web.Response(body=content,
                            content_type="application/octet-stream")


async def start_fake_dropbox() -> tuple[FakeDropbox, web.AppRunner]:
    fake = FakeDropbox()
    app = web.Application()
    app.router.add_post("/oauth2/token", fake.handle_token)
    app.router.add_post("/2/files/list_folder", fake.handle_list_folder)
    app.router.add_post("/2/files/download", fake.handle_download)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    assert runner.addresses
    fake.endpoint = f"http://127.0.0.1:{runner.addresses[0][1]}"
    return fake, runner
