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

import asyncio
import hashlib
import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

from aiohttp import web

# The Hub answers these to a paths-info body it cannot read as JSON, which
# is what an untyped fetch body is (measured against huggingface.co,
# 2026-09-24).
INVALID_PATHS = "✖ Invalid input\n  → at paths"

SEGMENTS = {"models": "", "datasets": "datasets/", "spaces": "spaces/"}


def blob_oid(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def lfs_oid(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def xet_hash(data: bytes) -> str:
    return hashlib.sha256(b"xet:" + data).hexdigest()


def dir_oid(path: str) -> str:
    return hashlib.sha1(b"tree " + path.encode()).hexdigest()


@dataclass
class FakeHub:
    """A Hugging Face Hub on a local port, for tests that need the wire.

    Speaks tree, paths-info and resolve the way the live Hub does: a
    missing subtree is 404 EntryNotFound, a paths-info body that is not
    JSON is 400, and resolve answers a redirect whose first hop carries a
    different ETag from the bytes it leads to. Files are Xet-shaped unless
    ``xet`` is off, so the final ETag is the xet hash rather than the git
    oid, exactly the case that separates checking the whole row from
    checking the oid alone.

    Args:
        repos (dict): ``(api segment, repo id)`` to ``{path: bytes}``.
        xet (bool): serve files Xet-shaped.
        listed (dict): path to the bytes the tree and paths-info describe
            instead of the served ones, to stage a listing behind the
            download; every id in the row describes that older version.
        etags (dict): path to the final ETag resolve serves instead.
        fail (dict): route name to ``(status, error code)`` it answers.
        log (list): ``(route, path)`` for every Hub-facing request.
        posts (list): each paths-info request's content type and body.
    """

    repos: dict[tuple[str, str], dict[str,
                                      bytes]] = field(default_factory=dict)
    xet: bool = True
    listed: dict[str, bytes] = field(default_factory=dict)
    etags: dict[str, str] = field(default_factory=dict)
    fail: dict[str, tuple[int, str]] = field(default_factory=dict)
    log: list[tuple[str, str]] = field(default_factory=list)
    posts: list[dict[str, Any]] = field(default_factory=list)
    url: str = ""

    def count(self, route: str) -> int:
        return sum(1 for name, _ in self.log if name == route)

    def row(self, path: str, data: bytes) -> dict[str, Any]:
        data = self.listed.get(path, data)
        row: dict[str, Any] = {
            "type": "file",
            "oid": blob_oid(data),
            "size": len(data),
            "path": path,
        }
        if self.xet:
            row["lfs"] = {
                "oid": lfs_oid(data),
                "size": len(data),
                "pointerSize": 134
            }
            row["xetHash"] = xet_hash(data)
        return row

    def etag(self, path: str, data: bytes) -> str:
        if path in self.etags:
            return self.etags[path]
        return xet_hash(data) if self.xet else blob_oid(data)

    def _failure(self, route: str) -> web.Response | None:
        if route not in self.fail:
            return None
        status, code = self.fail[route]
        return _error(status, code, f"fake {route} refused")

    def _files(self, request: web.Request) -> dict[str, bytes] | None:
        info = request.match_info
        return self.repos.get((info["seg"], f"{info['ns']}/{info['name']}"))

    async def tree(self, request: web.Request) -> web.Response:
        prefix = request.match_info.get("prefix", "").strip("/")
        self.log.append(("tree", prefix))
        refused = self._failure("tree")
        if refused is not None:
            return refused
        files = self._files(request)
        if files is None:
            return _error(404, "RepoNotFound", "Repository not found")
        under = prefix + "/" if prefix else ""
        rows = [
            self.row(p, d) for p, d in files.items() if p.startswith(under)
        ]
        if prefix and not rows:
            return _error(404, "EntryNotFound",
                          f"{prefix} does not exist on \"main\"")
        dirs = sorted({
            p.rsplit("/", 1)[0]
            for p in files if p.startswith(under) and "/" in p[len(under):]
        })
        rows = [_dir_row(d) for d in dirs] + rows
        return web.json_response(rows)

    async def paths_info(self, request: web.Request) -> web.Response:
        body = await request.read()
        kind = request.headers.get("Content-Type", "")
        self.posts.append({"content_type": kind, "body": body})
        self.log.append(("paths_info", body.decode(errors="replace")))
        refused = self._failure("paths_info")
        if refused is not None:
            return refused
        if "json" not in kind:
            return web.json_response({"error": INVALID_PATHS}, status=400)
        files = self._files(request)
        if files is None:
            return _error(404, "RepoNotFound", "Repository not found")
        rows = []
        for path in json.loads(body).get("paths", []):
            if path in files:
                rows.append(self.row(path, files[path]))
            elif any(p.startswith(path.rstrip("/") + "/") for p in files):
                rows.append(_dir_row(path.rstrip("/")))
        return web.json_response(rows)

    async def resolve(self, request: web.Request) -> web.Response:
        info = request.match_info
        path = info["path"]
        self.log.append(("resolve", path))
        refused = self._failure("resolve")
        if refused is not None:
            return refused
        files = self._files(request)
        if files is None or path not in files:
            return _error(404, "EntryNotFound", f"{path} not found")
        # The first hop names the LFS sha, never the bytes' own ETag, so
        # a client that read the wrong hop reads the wrong token.
        raise web.HTTPFound(
            f"/cdn/{info['seg']}/{info['ns']}/{info['name']}/{path}",
            headers={"X-Linked-Etag": f'"{lfs_oid(files[path])}"'})

    async def cdn(self, request: web.Request) -> web.Response:
        files = self._files(request)
        path = request.match_info["path"]
        data = (files or {})[path]
        headers = {"ETag": f'"{self.etag(path, data)}"'}
        span = request.headers.get("Range", "")
        if span.startswith("bytes="):
            first, _, last = span[len("bytes="):].partition("-")
            end = int(last) + 1 if last else len(data)
            return web.Response(status=206,
                                body=data[int(first):end],
                                headers=headers)
        return web.Response(body=data, headers=headers)


def _error(status: int, code: str, message: str) -> web.Response:
    headers = {"X-Error-Message": message}
    if code:
        headers["X-Error-Code"] = code
    return web.json_response({"error": message},
                             status=status,
                             headers=headers)


def _dir_row(path: str) -> dict[str, Any]:
    return {"type": "directory", "oid": dir_oid(path), "size": 0, "path": path}


def _app(hub: FakeHub) -> web.Application:
    app = web.Application()
    repo = "/api/{seg}/{ns}/{name}"
    app.router.add_get(repo + "/tree/{rev}", hub.tree)
    app.router.add_get(repo + "/tree/{rev}/{prefix:.*}", hub.tree)
    app.router.add_post(repo + "/paths-info/{rev}", hub.paths_info)
    app.router.add_get("/cdn/{seg}/{ns}/{name}/{path:.*}", hub.cdn)
    for seg, route in SEGMENTS.items():

        async def resolve(request: web.Request, seg: str = seg):
            request.match_info["seg"] = seg
            return await hub.resolve(request)

        app.router.add_get("/" + route + "{ns}/{name}/resolve/{rev}/{path:.*}",
                           resolve)
    return app


@contextmanager
def serve(hub: FakeHub | None = None) -> Iterator[FakeHub]:
    """Run ``hub`` on its own thread and loop, and yield it with ``url`` set.

    A thread of its own lets a test on ``asyncio.run`` and a test on the
    pytest loop share one fake, the way ThreadedMotoServer does for s3.

    Args:
        hub (FakeHub | None): the Hub to serve; a fresh empty one if None.
    """
    hub = hub or FakeHub()
    loop = asyncio.new_event_loop()
    ready = threading.Event()
    runner = web.AppRunner(_app(hub))

    async def start() -> None:
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        hub.url = f"http://127.0.0.1:{port}"

    def run() -> None:
        asyncio.set_event_loop(loop)
        loop.run_until_complete(start())
        ready.set()
        loop.run_forever()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    ready.wait()
    try:
        yield hub
    finally:
        asyncio.run_coroutine_threadsafe(runner.cleanup(), loop).result()
        loop.call_soon_threadsafe(loop.stop)
        thread.join()
        loop.close()
