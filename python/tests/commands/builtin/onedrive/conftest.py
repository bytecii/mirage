import fnmatch
import importlib
import posixpath
from collections.abc import AsyncIterator

import pytest

import mirage.resource.onedrive.onedrive as resource_mod
from mirage import MountMode, Workspace
from mirage.accessor.onedrive import OneDriveConfig
from mirage.commands.builtin.find_eval import FindEntry, keep
from mirage.resource.onedrive import OneDriveResource
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.filetype import guess_type

TEXT_FIXTURE_FILES = {
    "/words.txt": b"beta\nalpha\nalpha\n",
    "/more.txt": b"delta\n",
    "/table.csv": b"name,score\nann,2\nbob,3\n",
    "/table_extra.csv": b"name,score\ncam,5\n",
    "/data.json": b'{"name": "mirage"}\n',
    "/data2.json": b'{"name": "agent"}\n',
    "/events.jsonl": b'{"name": "first"}\n',
    "/events_extra.jsonl": b'{"name": "second"}\n',
    "/old.txt": b"same\nold\n",
    "/new.txt": b"same\nnew\n",
}

PATCH_MODULES = (
    "awk",
    "cat",
    "cp",
    "cut",
    "diff",
    "find",
    "grep",
    "head",
    "jq",
    "ls",
    "mkdir",
    "mv",
    "nl",
    "rg",
    "rm",
    "sort",
    "stat",
    "tail",
    "touch",
    "tr",
    "tree",
    "uniq",
    "wc",
)

IO_HELPERS = frozenset({
    "readdir",
    "_readdir",
    "stat",
    "_stat",
    "stat_core",
    "stat_impl",
    "read_bytes",
    "_read_bytes",
    "read_stream",
    "_read_stream",
    "write_bytes",
    "mkdir_impl",
    "copy",
    "rename",
    "unlink",
    "rmdir",
    "rm_r",
    "exists",
    "find_impl",
})


class FakeOneDriveStore:

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.dirs: set[str] = {"/"}

    def seed_dir(self, path: str) -> None:
        key = self.key(path)
        current = ""
        for part in key.strip("/").split("/"):
            if not part:
                continue
            current = current + "/" + part
            self.dirs.add(current)

    def seed_file(self, path: str, data: bytes) -> None:
        key = self.key(path)
        self.seed_dir(posixpath.dirname(key) or "/")
        self.files[key] = data

    def key(self, path: PathSpec | str) -> str:
        raw = path.original if isinstance(path, PathSpec) else str(path)
        prefix = path.prefix if isinstance(path, PathSpec) else ""
        if prefix and raw.startswith(prefix):
            rest = raw[len(prefix):]
            if prefix.endswith("/") or rest == "" or rest.startswith("/"):
                raw = rest or "/"
        if raw == "/onedrive":
            raw = "/"
        elif raw.startswith("/onedrive/"):
            raw = raw[len("/onedrive"):]
        raw = "/" + raw.strip("/")
        return raw if raw != "/" else "/"

    def prefixed(self, key: str, prefix: str) -> str:
        key = self.key(key)
        if not prefix:
            return key
        return prefix.rstrip("/") + ("" if key == "/" else key)

    async def resolve_glob(self, accessor, paths, index):
        resolved: list[PathSpec] = []
        for path in paths:
            if path.resolved or not path.pattern:
                resolved.append(path)
                continue
            parent = self.key(path.dir)
            for child in self.children(parent):
                name = child.rsplit("/", 1)[-1]
                if fnmatch.fnmatch(name, path.pattern):
                    resolved.append(
                        PathSpec.from_str_path(
                            self.prefixed(child, path.prefix), path.prefix))
        return resolved

    def children(self, path: PathSpec | str) -> list[str]:
        parent = self.key(path).rstrip("/") or "/"
        if parent not in self.dirs:
            if parent in self.files:
                raise NotADirectoryError(parent)
            raise FileNotFoundError(parent)
        entries = set()
        for dirname in self.dirs:
            if dirname == parent:
                continue
            if posixpath.dirname(dirname) == parent:
                entries.add(dirname)
        for filename in self.files:
            if posixpath.dirname(filename) == parent:
                entries.add(filename)
        return sorted(entries)

    async def readdir(self, accessor, path, index=None) -> list[str]:
        prefix = path.prefix if isinstance(path, PathSpec) else ""
        return [self.prefixed(child, prefix) for child in self.children(path)]

    async def stat(self, accessor, path, index=None) -> FileStat:
        key = self.key(path)
        if key in self.dirs:
            name = key.rsplit("/", 1)[-1] or "/"
            return FileStat(name=name, type=FileType.DIRECTORY)
        if key in self.files:
            name = key.rsplit("/", 1)[-1]
            return FileStat(name=name,
                            size=len(self.files[key]),
                            type=guess_type(name))
        raise FileNotFoundError(key)

    async def read_bytes(self,
                         accessor,
                         path,
                         index=None,
                         *args,
                         **kwargs) -> bytes:
        key = self.key(path)
        if key not in self.files:
            raise FileNotFoundError(key)
        return self.files[key]

    async def read_stream(self,
                          accessor,
                          path,
                          index=None,
                          *args,
                          **kwargs) -> AsyncIterator[bytes]:
        yield await self.read_bytes(accessor, path, index, *args, **kwargs)

    async def write_bytes(self, accessor, path, data: bytes) -> None:
        self.seed_file(self.key(path), data)

    async def exists(self, accessor, path) -> bool:
        key = self.key(path)
        return key in self.files or key in self.dirs

    async def mkdir(self, accessor, path) -> None:
        self.seed_dir(self.key(path))

    async def copy(self, accessor, src, dst) -> None:
        src_key = self.key(src)
        dst_key = self.key(dst)
        if src_key in self.files:
            self.seed_file(dst_key, self.files[src_key])
            return
        if src_key not in self.dirs:
            raise FileNotFoundError(src_key)
        self.seed_dir(dst_key)
        for key, data in list(self.files.items()):
            if key.startswith(src_key.rstrip("/") + "/"):
                suffix = key[len(src_key.rstrip("/")):]
                self.seed_file(dst_key.rstrip("/") + suffix, data)

    async def rename(self, accessor, src, dst) -> None:
        await self.copy(accessor, src, dst)
        await self.rm_r(accessor, src)

    async def unlink(self, accessor, path) -> None:
        key = self.key(path)
        if key not in self.files:
            raise FileNotFoundError(key)
        del self.files[key]

    async def rmdir(self, accessor, path) -> None:
        key = self.key(path)
        if self.children(key):
            raise OSError(f"directory not empty: {key}")
        self.dirs.remove(key)

    async def rm_r(self, accessor, path) -> None:
        key = self.key(path).rstrip("/") or "/"
        for filename in list(self.files):
            if filename == key or filename.startswith(key + "/"):
                del self.files[filename]
        for dirname in sorted(self.dirs, key=len, reverse=True):
            if dirname != "/" and (dirname == key
                                   or dirname.startswith(key + "/")):
                self.dirs.remove(dirname)

    async def find(self,
                   accessor,
                   path,
                   name=None,
                   type=None,
                   maxdepth=None,
                   mindepth=None,
                   tree=None,
                   **kwargs) -> list[str]:
        base = self.key(path).rstrip("/") or "/"
        results: list[str] = []
        for key in sorted(self.dirs | set(self.files)):
            if key == "/":
                continue
            if base != "/" and key != base and not key.startswith(base + "/"):
                continue
            rel = key[len(base):].strip("/") if base != "/" else key.strip("/")
            depth = 0 if key == base else rel.count("/") + 1
            if maxdepth is not None and depth > maxdepth:
                continue
            if mindepth is not None and depth < mindepth:
                continue
            is_dir = key in self.dirs
            if type == "f" and is_dir:
                continue
            if type == "d" and not is_dir:
                continue
            if name and not fnmatch.fnmatch(key.rsplit("/", 1)[-1], name):
                continue
            if tree is not None:
                entry = FindEntry(key=key,
                                  name=key.rsplit("/", 1)[-1],
                                  kind="d" if is_dir else "f",
                                  depth=depth)
                if not keep(entry, tree, mindepth):
                    continue
            results.append(key)
        return results


def patch_attr(monkeypatch, module, name: str, value) -> bool:
    if hasattr(module, name):
        monkeypatch.setattr(module, name, value)
        return True
    return False


def patch_module(monkeypatch, store: FakeOneDriveStore, name: str) -> None:
    module = importlib.import_module(
        f"mirage.commands.builtin.onedrive.{name}")
    targets = {
        "resolve_glob": store.resolve_glob,
        "readdir": store.readdir,
        "_readdir": store.readdir,
        "stat": store.stat,
        "_stat": store.stat,
        "stat_core": store.stat,
        "stat_impl": store.stat,
        "read_bytes": store.read_bytes,
        "_read_bytes": store.read_bytes,
        "read_stream": store.read_stream,
        "_read_stream": store.read_stream,
        "write_bytes": store.write_bytes,
        "mkdir_impl": store.mkdir,
        "copy": store.copy,
        "rename": store.rename,
        "unlink": store.unlink,
        "rmdir": store.rmdir,
        "rm_r": store.rm_r,
        "exists": store.exists,
        "find_impl": store.find,
    }
    patched = {
        attr
        for attr, value in targets.items()
        if patch_attr(monkeypatch, module, attr, value)
    }
    assert patched & IO_HELPERS, (
        f"onedrive.{name}: no known I/O helper was patched; the fake store is "
        "not installed, so the test may reach the real OneDrive accessor. "
        "Update IO_HELPERS/targets to match the module's imported helpers.")


@pytest.fixture
def onedrive_files(monkeypatch) -> FakeOneDriveStore:
    store = FakeOneDriveStore()
    for path, data in TEXT_FIXTURE_FILES.items():
        store.seed_file(path, data)
    store.seed_file("/.hidden", b"hidden\n")
    store.seed_dir("/sub")
    store.seed_file("/sub/inner.txt", b"gamma\nalpha\n")
    for name in PATCH_MODULES:
        patch_module(monkeypatch, store, name)
    monkeypatch.setattr(resource_mod, "_resolve_glob", store.resolve_glob)
    return store


@pytest.fixture
def onedrive_read_ws(onedrive_files) -> Workspace:
    resource = OneDriveResource(OneDriveConfig(access_token="tok"))
    return Workspace({"/onedrive/": resource}, mode=MountMode.READ)


@pytest.fixture
def onedrive_write_ws(onedrive_files) -> Workspace:
    resource = OneDriveResource(OneDriveConfig(access_token="tok"))
    return Workspace({"/onedrive/": resource}, mode=MountMode.WRITE)
