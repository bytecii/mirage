import asyncio

import pytest

from mirage.commands.builtin import grep_offsets
from mirage.commands.builtin.generic.rg import parse_flags, rg
from mirage.commands.config import CommandOpts
from mirage.commands.spec.flag_view import FlagView
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key


def _spec(path: str) -> PathSpec:
    return PathSpec(vfs_path=(path).strip("/"),
                    virtual=path,
                    directory=path,
                    resolved=True)


def _make_backend(files: dict[str, bytes], dirs: set[str] | None = None):
    inferred_dirs = set(dirs) if dirs is not None else set()
    for f in files:
        parts = f.split("/")
        for i in range(1, len(parts)):
            d = "/".join(parts[:i]) or "/"
            inferred_dirs.add(d)
    inferred_dirs.add("/")

    async def readdir(path):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            vfs_path=(path).strip("/"), virtual=path, directory=path)
        p = spec.virtual.rstrip("/") or "/"
        if p not in inferred_dirs:
            raise FileNotFoundError(p)
        prefix = p + "/" if p != "/" else "/"
        children: set[str] = set()
        for f in files:
            if f.startswith(prefix):
                rest = f[len(prefix):]
                child = rest.split("/")[0]
                children.add(prefix + child)
        for d in inferred_dirs:
            if d == p:
                continue
            if d.startswith(prefix):
                rest = d[len(prefix):]
                child = rest.split("/")[0]
                children.add(prefix + child)
        return sorted(children)

    async def stat(path):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            vfs_path=(path).strip("/"), virtual=path, directory=path)
        p = spec.virtual
        if p in files:
            return FileStat(name=p.rsplit("/", 1)[-1] or p,
                            size=len(files[p]),
                            type=FileType.FILE,
                            content=ContentType.TEXT)
        if p.rstrip("/") in inferred_dirs or p in inferred_dirs:
            return FileStat(name=p.rsplit("/", 1)[-1] or "/",
                            type=FileType.DIRECTORY)
        raise FileNotFoundError(p)

    async def read_bytes(path):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            vfs_path=(path).strip("/"), virtual=path, directory=path)
        if spec.virtual not in files:
            raise FileNotFoundError(spec.virtual)
        return files[spec.virtual]

    async def read_stream(path):
        data = await read_bytes(path)
        yield data

    return readdir, stat, read_bytes, read_stream


async def _drain_async(stdout):
    if stdout is None:
        return b""
    if isinstance(stdout, bytes):
        return stdout
    chunks = [chunk async for chunk in stdout]
    return b"".join(chunks)


@pytest.mark.asyncio
async def test_rg_stdin_basic():
    readdir, stat, rb, rs = _make_backend({})
    output, _ = await rg(
        [],
        ["apple"],
        CommandOpts(),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"apple\nbanana\napricot\n",
    )
    decoded = (await _drain_async(output)).decode()
    assert "apple" in decoded
    assert "banana" not in decoded


@pytest.mark.asyncio
async def test_rg_count_stdin_uses_match_count():
    readdir, stat, rb, rs = _make_backend({})
    output, io = await rg(
        [],
        ["foo"],
        CommandOpts(flags={"c": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"foo foo\nfoo bar\nbaz\n",
    )
    assert (await _drain_async(output)) == b"2\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_rg_count_stdin_zero_exits_1_without_output():
    readdir, stat, rb, rs = _make_backend({})
    output, io = await rg(
        [],
        ["foo"],
        CommandOpts(flags={"c": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"bar\nbaz\n",
    )
    assert await _drain_async(output) == b""
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_rg_file_basic():
    readdir, stat, rb, rs = _make_backend({
        "/a.txt":
        b"apple\nbanana\napricot\n",
    })
    output, _ = await rg(
        [_spec("/a.txt")],
        ["ap"],
        CommandOpts(),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "apple" in decoded
    assert "apricot" in decoded
    assert "banana" not in decoded


@pytest.mark.asyncio
async def test_rg_no_match_returns_exit_1():
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"hello\nworld\n"})
    output, io = await rg(
        [_spec("/a.txt")],
        ["zzz"],
        CommandOpts(),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    drained = await _drain_async(output)
    assert drained == b""
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_rg_dir_auto_recursive():
    """rg on a bare directory should auto-recurse (matches real ripgrep)."""
    readdir, stat, rb, rs = _make_backend({
        "/dir/a.txt": b"apple\n",
        "/dir/sub/b.txt": b"apricot\n",
    })
    output, _ = await rg(
        [_spec("/dir")],
        ["ap"],
        CommandOpts(),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "apple" in decoded
    assert "apricot" in decoded


@pytest.mark.asyncio
async def test_rg_count_dir_skips_zero_count_files():
    readdir, stat, rb, rs = _make_backend({
        "/dir/a.txt": b"foo\nbar\nfoo\n",
        "/dir/b.txt": b"bar\nbaz\n",
    })
    output, io = await rg(
        [_spec("/dir")],
        ["foo"],
        CommandOpts(flags={"c": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "/dir/a.txt:2" in decoded
    assert "/dir/b.txt" not in decoded
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_rg_files_only_on_dir():
    readdir, stat, rb, rs = _make_backend({
        "/dir/a.txt": b"apple\n",
        "/dir/b.txt": b"zebra\n",
    })
    output, _ = await rg(
        [_spec("/dir")],
        ["apple"],
        CommandOpts(flags={"args_l": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "/dir/a.txt" in decoded
    assert "/dir/b.txt" not in decoded


@pytest.mark.asyncio
async def test_rg_hidden_excluded_by_default():
    readdir, stat, rb, rs = _make_backend({
        "/dir/.hidden": b"apple\n",
        "/dir/visible.txt": b"apple\n",
    })
    output, _ = await rg(
        [_spec("/dir")],
        ["apple"],
        CommandOpts(flags={"args_l": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "/dir/visible.txt" in decoded
    assert ".hidden" not in decoded


@pytest.mark.asyncio
async def test_rg_hidden_included_with_flag():
    readdir, stat, rb, rs = _make_backend({
        "/dir/.hidden": b"apple\n",
        "/dir/visible.txt": b"apple\n",
    })
    output, _ = await rg(
        [_spec("/dir")],
        ["apple"],
        CommandOpts(flags={
            "args_l": True,
            "hidden": True
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "/dir/visible.txt" in decoded
    assert ".hidden" in decoded


@pytest.mark.asyncio
async def test_rg_file_type_filter():
    readdir, stat, rb, rs = _make_backend({
        "/dir/a.py": b"apple\n",
        "/dir/b.txt": b"apple\n",
    })
    output, _ = await rg(
        [_spec("/dir")],
        ["apple"],
        CommandOpts(flags={
            "args_l": True,
            "type": "py"
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "/dir/a.py" in decoded
    assert "/dir/b.txt" not in decoded


@pytest.mark.asyncio
async def test_rg_glob_filter():
    readdir, stat, rb, rs = _make_backend({
        "/dir/a.log": b"apple\n",
        "/dir/b.txt": b"apple\n",
    })
    output, _ = await rg(
        [_spec("/dir")],
        ["apple"],
        CommandOpts(flags={
            "args_l": True,
            "glob": "*.log"
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "/dir/a.log" in decoded
    assert "/dir/b.txt" not in decoded


def _make_prefixed_backend(files: dict[str, bytes], mount_prefix: str):
    """Backend that mimics real s3/disk/gdrive readdir: entries returned
    are already prepended with ``mount_prefix``. Used to catch wrapper bugs
    that re-add the prefix or drop ``index``."""

    full_files = {mount_prefix + k: v for k, v in files.items()}
    inferred_dirs: set[str] = {mount_prefix or "/"}
    for f in full_files:
        parts = f.split("/")
        for i in range(1, len(parts)):
            d = "/".join(parts[:i]) or "/"
            inferred_dirs.add(d)

    def _full(p: str) -> str:
        if mount_prefix and not p.startswith(mount_prefix):
            return mount_prefix + p
        return p

    async def readdir(path):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            vfs_path=(path).strip("/"), virtual=path, directory=path)
        p = _full(spec.virtual).rstrip("/") or "/"
        if p not in inferred_dirs:
            raise FileNotFoundError(p)
        prefix = p + "/" if p != "/" else "/"
        children: set[str] = set()
        for f in full_files:
            if f.startswith(prefix):
                child = prefix + f[len(prefix):].split("/")[0]
                children.add(child)
        for d in inferred_dirs:
            if d == p or not d.startswith(prefix):
                continue
            child = prefix + d[len(prefix):].split("/")[0]
            children.add(child)
        return sorted(children)

    async def stat(path):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            vfs_path=(path).strip("/"), virtual=path, directory=path)
        p = _full(spec.virtual)
        if p in full_files:
            return FileStat(name=p.rsplit("/", 1)[-1],
                            size=len(full_files[p]),
                            type=FileType.FILE,
                            content=ContentType.TEXT)
        if p.rstrip("/") in inferred_dirs:
            return FileStat(name=p.rsplit("/", 1)[-1] or "/",
                            type=FileType.DIRECTORY)
        raise FileNotFoundError(p)

    async def read_bytes(path):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            vfs_path=(path).strip("/"), virtual=path, directory=path)
        p = _full(spec.virtual)
        if p not in full_files:
            raise FileNotFoundError(p)
        return full_files[p]

    return readdir, stat, read_bytes


@pytest.mark.asyncio
async def test_rg_files_only_mount_prefix_not_doubled():
    readdir, stat, rb = _make_prefixed_backend(
        {
            "/dir/a.txt": b"apple\n",
            "/dir/b.txt": b"zebra\n",
        },
        mount_prefix="/s3",
    )
    p = PathSpec(vfs_path=mount_key("/dir", "/s3"),
                 virtual="/dir",
                 directory="/dir",
                 resolved=True)
    output, _ = await rg(
        [p],
        ["apple"],
        CommandOpts(flags={"args_l": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=None,
    )
    decoded = (await _drain_async(output)).decode().strip()
    assert decoded == "/s3/dir/a.txt"
    assert "/s3/s3" not in decoded


@pytest.mark.asyncio
async def test_rg_multiple_dirs_searches_all():
    readdir, stat, rb, rs = _make_backend({
        "/d1/a.txt": b"apple a\n",
        "/d2/b.txt": b"apple b\n",
    })
    output, _ = await rg(
        [_spec("/d1"), _spec("/d2")],
        ["apple"],
        CommandOpts(),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "/d1/a.txt:apple a" in decoded
    assert "/d2/b.txt:apple b" in decoded


@pytest.mark.asyncio
async def test_rg_files_only_multiple_files():
    readdir, stat, rb, rs = _make_backend({
        "/t1.txt": b"apple\n",
        "/t2.txt": b"apple\n",
    })
    output, _ = await rg(
        [_spec("/t1.txt"), _spec("/t2.txt")],
        ["apple"],
        CommandOpts(flags={"args_l": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "/t1.txt" in decoded
    assert "/t2.txt" in decoded


def test_parse_flags_c_overrides_a_and_b():
    f = parse_flags(FlagView({
        "A": "2",
        "B": "1",
        "C": "4"
    }),
                    never_match=False)
    assert f.context_after == 4
    assert f.context_before == 4
    f = parse_flags(FlagView({"A": "2"}), never_match=False)
    assert f.context_after == 2
    assert f.context_before == 0


def test_parse_flags_struct_rejects_typos():
    f = parse_flags(FlagView({"hidden": True}), never_match=False)
    assert f.hidden is True
    with pytest.raises(AttributeError):
        _ = f.hiden


@pytest.mark.asyncio
async def test_rg_with_filename_labels_single_file():
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"apple\nbanana\n"})
    output, _ = await rg(
        [_spec("/a.txt")],
        ["ap"],
        CommandOpts(flags={"H": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert (await _drain_async(output)).decode() == "/a.txt:apple\n"


@pytest.mark.asyncio
async def test_rg_with_filename_labels_single_file_count():
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"apple\napricot\n"})
    output, _ = await rg(
        [_spec("/a.txt")],
        ["ap"],
        CommandOpts(flags={
            "H": True,
            "c": True
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert (await _drain_async(output)).decode() == "/a.txt:2\n"


@pytest.mark.asyncio
async def test_rg_no_filename_suppresses_multi_file_labels():
    readdir, stat, rb, rs = _make_backend({
        "/a.txt": b"apple\n",
        "/b.txt": b"apricot\n",
    })
    output, _ = await rg(
        [_spec("/a.txt"), _spec("/b.txt")],
        ["ap"],
        CommandOpts(flags={"args_I": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert (await _drain_async(output)).decode() == "apple\napricot\n"


LOG = (b"error: disk full\nwarning: low memory\ninfo: all good\n"
       b"error: timeout\nnote: done\n")


@pytest.mark.asyncio
async def test_rg_context_after_single_file():
    readdir, stat, rb, rs = _make_backend({"/app.log": LOG})
    output, io = await rg(
        [_spec("/app.log")],
        ["warning"],
        CommandOpts(flags={"A": "1"}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "warning: low memory\ninfo: all good\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_rg_context_c_merges_adjacent_groups():
    readdir, stat, rb, rs = _make_backend({"/app.log": LOG})
    output, _ = await rg(
        [_spec("/app.log")],
        ["error"],
        CommandOpts(flags={"C": "1"}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == ("error: disk full\nwarning: low memory\n"
                       "info: all good\nerror: timeout\nnote: done\n")


@pytest.mark.asyncio
async def test_rg_context_line_numbers_use_dash_separator():
    readdir, stat, rb, rs = _make_backend({"/app.log": LOG})
    output, _ = await rg(
        [_spec("/app.log")],
        ["warning"],
        CommandOpts(flags={
            "n": True,
            "A": "1"
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "2:warning: low memory\n3-info: all good\n"


@pytest.mark.asyncio
async def test_rg_context_respects_max_count():
    readdir, stat, rb, rs = _make_backend({"/app.log": LOG})
    output, _ = await rg(
        [_spec("/app.log")],
        ["error"],
        CommandOpts(flags={
            "m": "1",
            "C": "1"
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "error: disk full\nwarning: low memory\n"


@pytest.mark.asyncio
async def test_rg_context_separates_distant_groups():
    readdir, stat, rb, rs = _make_backend({"/f.txt": b"hit\na\nb\nc\nhit\n"})
    output, _ = await rg(
        [_spec("/f.txt")],
        ["hit"],
        CommandOpts(flags={"A": "1"}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "hit\na\n--\nhit\n"


@pytest.mark.asyncio
async def test_rg_dir_search_ignores_context():
    # Deliberate divergence: directory search skips context lines,
    # mirroring grep's -H divergence.
    readdir, stat, rb, rs = _make_backend({"/dir/app.log": LOG})
    output, _ = await rg(
        [_spec("/dir")],
        ["warning"],
        CommandOpts(flags={"A": "1"}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "/dir/app.log:warning: low memory\n"


@pytest.mark.asyncio
async def test_rg_no_filename_dir_walk():
    readdir, stat, rb, rs = _make_backend({
        "/dir/a.txt": b"alpha one\n",
        "/dir/b.txt": b"alpha two\n",
    })
    output, _ = await rg(
        [_spec("/dir")],
        ["alpha"],
        CommandOpts(flags={"args_I": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "alpha one\nalpha two\n"


@pytest.mark.asyncio
async def test_rg_multi_file_missing_operand_reports_and_continues():
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"hello\nworld\n"})
    output, io = await rg(
        [_spec("/a.txt"), _spec("/nope.txt")],
        ["o"],
        CommandOpts(),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "/a.txt:hello\n/a.txt:world\n"
    assert io.stderr == b"rg: /nope.txt: No such file or directory\n"
    assert io.exit_code == 2


@pytest.mark.asyncio
async def test_rg_not_a_directory_operand_keeps_the_others():
    """readdir on a path whose component is a file raises ENOTDIR. rg must
    warn for that operand and keep searching the rest, as it does for ENOENT.
    """
    readdir, stat, rb, rs = _make_backend({
        "/a.txt": b"hello\n",
        "/real/b.txt": b"foo\n",
    })

    async def readdir_enotdir(path):
        p = path.virtual if isinstance(path, PathSpec) else path
        if p.startswith("/a.txt/"):
            raise NotADirectoryError(p)
        return await readdir(path)

    output, io = await rg(
        [_spec("/a.txt/x"), _spec("/real")],
        ["foo"],
        CommandOpts(flags={"args_l": True}),
        readdir=readdir_enotdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "/real/b.txt\n"
    assert b"/a.txt/x" in (io.stderr or b"")


@pytest.mark.asyncio
@pytest.mark.parametrize("flags,prefix", [
    ({}, ""),
    ({
        "H": True
    }, "/binary.txt:"),
    ({
        "args_I": True
    }, ""),
    ({
        "H": True,
        "args_I": True
    }, ""),
])
async def test_rg_filename_flags_preserve_nul_matches(flags, prefix):
    readdir, stat, rb, rs = _make_backend({"/binary.txt": b"needle\0tail\n"})
    output, io = await rg(
        [_spec("/binary.txt")],
        ["needle"],
        CommandOpts(flags=flags),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert await _drain_async(output) == prefix.encode() + b"needle\0tail\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_rg_no_filename_preserves_multi_file_nul_matches():
    readdir, stat, rb, rs = _make_backend({
        "/a.txt": b"needle\0a\n",
        "/b.txt": b"needle\0b\n",
    })
    output, io = await rg(
        [_spec("/a.txt"), _spec("/b.txt")],
        ["needle"],
        CommandOpts(flags={"args_I": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert await _drain_async(output) == b"needle\0a\nneedle\0b\n"
    assert io.exit_code == 0


async def _endless_after_first_match():
    yield b"hello\n"
    raise RuntimeError("the probe read past the first selected line")


@pytest.mark.asyncio
async def test_rg_files_without_match_stdin_stops_at_the_first_match():
    # A stdin that never ends must not be buffered whole: the probe
    # streams through the scanner and stops on the first selected line.
    readdir, stat, rb, rs = _make_backend({})
    output, io = await rg(
        [],
        ["hello"],
        CommandOpts(flags={"files_without_match": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        stdin=_endless_after_first_match(),
    )
    assert await _drain_async(output) == b""
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_rg_files_without_match_stdin_lists_stdin_when_nothing_matches():
    readdir, stat, rb, rs = _make_backend({})
    output, io = await rg(
        [],
        ["hello"],
        CommandOpts(flags={"files_without_match": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"x\ny\n",
    )
    assert await _drain_async(output) == b"<stdin>\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_rg_files_without_match_stdin_m0_lists_nothing():
    # ripgrep 14.1.1: `printf 'x\n' | rg --files-without-match -m0 hello`
    # prints nothing and exits 1, matched input or not.
    readdir, stat, rb, rs = _make_backend({})
    for data in (b"x\n", b"hello\n"):
        output, io = await rg(
            [],
            ["hello"],
            CommandOpts(flags={
                "files_without_match": True,
                "m": "0"
            }),
            readdir=readdir,
            stat=stat,
            read_bytes=rb,
            read_stream=rs,
            stdin=data,
        )
        assert await _drain_async(output) == b""
        assert io.exit_code == 1


def test_rg_output_mode_is_the_last_of_c_l_and_files_without_match():
    # ripgrep 14.1.1: `-c --files-without-match` lists the matchless
    # files, `--files-without-match -c` prints counts, `-l -c` counts.
    later = parse_flags(FlagView({
        "c": True,
        "files_without_match": True
    }),
                        never_match=False)
    assert (later.count_only, later.files_without_match) == (False, True)
    earlier = parse_flags(FlagView({
        "files_without_match": True,
        "c": True
    }),
                          never_match=False)
    assert (earlier.count_only, earlier.files_without_match) == (True, False)
    counted = parse_flags(FlagView({
        "args_l": True,
        "c": True
    }),
                          never_match=False)
    assert (counted.files_only, counted.count_only) == (False, True)


def _stdin_operand(raw: str = "-") -> PathSpec:
    # How the classifier hands a typed `-` over: resolved under the cwd,
    # spelled as typed.
    virtual = "/dev/stdin" if raw == "/dev/stdin" else "/-"
    return PathSpec(vfs_path=virtual.strip("/"),
                    virtual=virtual,
                    directory="/",
                    resolved=True,
                    raw_path=raw)


async def _run(paths: list[PathSpec],
               texts: list[str],
               flags: dict,
               stdin,
               files: dict[str, bytes] | None = None):
    readdir, stat, rb, rs = _make_backend(files or {})
    output, io = await rg(paths,
                          texts,
                          CommandOpts(flags=flags),
                          readdir=readdir,
                          stat=stat,
                          read_bytes=rb,
                          read_stream=rs,
                          stdin=stdin)
    return await _drain_async(output), io


@pytest.mark.asyncio
async def test_rg_dash_operand_reads_stdin():
    # ripgrep 14.1.1: `printf 'b\n' | rg b -` prints `b`, exit 0. The
    # backend holds no `/-`, so reading one would fail the line.
    out, io = await _run([_stdin_operand()], ["b"], {}, b"b\n")
    assert (out, io.exit_code) == (b"b\n", 0)


@pytest.mark.asyncio
async def test_rg_dash_beside_a_file_is_named_stdin():
    files = {"/a.txt": b"hello\nworld\n"}
    out, io = await _run([_stdin_operand(), _spec("/a.txt")], ["world"], {},
                         b"world\n", files)
    assert (out, io.exit_code) == (b"<stdin>:world\n/a.txt:world\n", 0)
    out, io = await _run([_stdin_operand(), _spec("/a.txt")], ["world"],
                         {"c": True}, b"world\n", files)
    assert (out, io.exit_code) == (b"<stdin>:1\n/a.txt:1\n", 0)


@pytest.mark.asyncio
async def test_rg_dash_twice_reads_stdin_once():
    # Both operands read one cursor: the second finds it drained.
    out, io = await _run([_stdin_operand(), _stdin_operand()], ["b"], {},
                         b"b\n")
    assert (out, io.exit_code) == (b"<stdin>:b\n", 0)
    out, io = await _run([_stdin_operand(), _stdin_operand()], ["z"],
                         {"files_without_match": True}, b"b\n")
    assert (out, io.exit_code) == (b"<stdin>\n<stdin>\n", 0)


@pytest.mark.asyncio
async def test_rg_dash_listing_names_stdin():
    out, io = await _run([_stdin_operand()], ["b"], {"args_l": True}, b"b\n")
    assert (out, io.exit_code) == (b"<stdin>\n", 0)
    out, io = await _run([_stdin_operand()], ["z"], {"args_l": True}, b"b\n")
    assert (out, io.exit_code) == (b"", 1)
    out, io = await _run([_stdin_operand()], ["z"],
                         {"files_without_match": True}, b"b\n")
    assert (out, io.exit_code) == (b"<stdin>\n", 0)
    out, io = await _run([_stdin_operand()], ["b"],
                         {"files_without_match": True}, b"b\n")
    assert (out, io.exit_code) == (b"", 1)


@pytest.mark.asyncio
@pytest.mark.parametrize("flags", [{
    "args_l": True
}, {
    "files_without_match": True
}])
async def test_rg_dash_listing_stops_at_the_first_match(flags):
    # The listing is settled by the first selected line, so an endless
    # stdin is never read past it.
    out, io = await _run([_stdin_operand()], ["hello"], flags,
                         _endless_after_first_match())
    expected = (b"<stdin>\n", 0) if "args_l" in flags else (b"", 1)
    assert (out, io.exit_code) == expected


@pytest.mark.asyncio
async def test_rg_dash_is_never_filtered_by_type_or_glob():
    # ripgrep searches an explicit operand whatever --type or --glob say,
    # and stdin is always explicit.
    for flags in ({"type": "py"}, {"glob": "*.rs"}):
        out, io = await _run([_stdin_operand()], ["b"], flags, b"b\n")
        assert (out, io.exit_code) == (b"b\n", 0)


@pytest.mark.asyncio
async def test_rg_dash_prints_context():
    out, io = await _run([_stdin_operand()], ["b"], {"C": "1"}, b"a\nb\nc\n")
    assert (out, io.exit_code) == (b"a\nb\nc\n", 0)


@pytest.mark.asyncio
async def test_rg_dev_stdin_reads_stdin_under_its_own_name():
    # ripgrep opens /dev/stdin as the path it is, so a label names it.
    files = {"/a.txt": b"world\n"}
    out, io = await _run([_stdin_operand("/dev/stdin"),
                          _spec("/a.txt")], ["world"], {}, b"world\n", files)
    assert (out, io.exit_code) == (b"/dev/stdin:world\n/a.txt:world\n", 0)


async def _pipe_that_goes_on(first: bytes):
    yield first
    raise AssertionError("read past the answer")


@pytest.mark.asyncio
@pytest.mark.parametrize("flags, paths, want", [
    ({
        "m": "1",
        "C": "1"
    }, [None], b"a\nb\nc\n"),
    ({
        "m": "1",
        "type": "py"
    }, [None], b"b\n"),
    ({
        "m": "1"
    }, [None, "/a.txt"], b"<stdin>:b\n"),
])
async def test_rg_dash_stops_reading_at_max_count(flags, paths, want):
    # -m is answered once its last selected line (and that line's
    # trailing context) is out, so a pipe that goes on is never waited
    # on: in the full-scan branch (context, --type) and beside a file.
    operands = [_stdin_operand() if p is None else _spec(p) for p in paths]
    out, io = await _run(operands, ["b"], flags,
                         _pipe_that_goes_on(b"a\nb\nc\n"),
                         {"/a.txt": b"hello\nworld\n"})
    assert (out, io.exit_code) == (want, 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("flags, data, want", [
    ({
        "args_l": True
    }, b"b\n", (b"<stdin>\n", 0)),
    ({
        "H": True
    }, b"b\n", (b"<stdin>:b\n", 0)),
    ({
        "H": True,
        "c": True
    }, b"b\n", (b"<stdin>:1\n", 0)),
    ({
        "C": "1"
    }, b"a\nb\nc\n", (b"a\nb\nc\n", 0)),
    ({
        "type": "rust"
    }, b"b\n", (b"b\n", 0)),
    ({
        "args_l": True,
        "m": "0"
    }, b"b\n", (b"", 1)),
])
async def test_rg_no_operand_searches_stdin_as_an_implicit_dash(
        flags, data, want):
    # ripgrep 14.1.1 searches a piped stdin as an implicit `-` when the
    # line names no path, so every flag answers as it does for a typed
    # one: `printf 'b\n' | rg -l b` prints `<stdin>`.
    out, io = await _run([], ["b"], flags, data)
    assert (out, io.exit_code) == want


@pytest.mark.asyncio
@pytest.mark.parametrize("flags, want", [
    ({
        "args_l": True
    }, b"<stdin>\n"),
    ({
        "m": "1",
        "C": "1"
    }, b"a\nb\nc\n"),
    ({
        "m": "1",
        "H": True
    }, b"<stdin>:b\n"),
])
async def test_rg_no_operand_stops_reading_at_the_answer(flags, want):
    out, io = await _run([], ["b"], flags, _pipe_that_goes_on(b"a\nb\nc\n"))
    assert (out, io.exit_code) == (want, 0)


@pytest.mark.asyncio
async def test_rg_no_operand_cancellation_closes_stdin(monkeypatch):
    # The implicit operand is stdin's sole reader, so a search cancelled
    # mid-line closes the input rather than leaving it half read.
    closed = False
    calls = 0
    task = asyncio.current_task()
    original = grep_offsets.MatchOffsets.at

    def measured(self, index):
        nonlocal calls
        if calls == 0:
            asyncio.get_running_loop().call_later(0, task.cancel)
        calls += 1
        return original(self, index)

    async def source():
        nonlocal closed
        try:
            yield b"needle " * 100000 + b"\n"
            raise AssertionError("read beyond the matching line")
        finally:
            closed = True

    monkeypatch.setattr(grep_offsets.MatchOffsets, "at", measured)
    with pytest.raises(asyncio.CancelledError):
        await _run([], ["needle"], {"o": True, "byte_offset": True}, source())
    assert closed
    assert calls < 100000
