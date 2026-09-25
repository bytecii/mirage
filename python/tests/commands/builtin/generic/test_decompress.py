import gzip

import pytest

from mirage.commands.builtin.generic.decompress import decompress_inputs
from mirage.io.types import materialize
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_fatal_input_never_reads_later_operands_or_stdin():
    reads = []

    async def read(path):
        reads.append(path.virtual)
        return b""

    async def stdin():
        reads.append("stdin")
        yield gzip.compress(b"hello")

    paths = [
        PathSpec.from_str_path(p) for p in ("/a/bad.gz", "/b/missing.gz", "-")
    ]
    body, io = await decompress_inputs(paths,
                                       command="zcat",
                                       read=read,
                                       stdin=stdin(),
                                       to_stdout=True)
    assert await materialize(body) == b""
    assert reads == ["/a/bad.gz"]
    assert io.exit_code == 1
    assert io.stderr == b"zcat: /a/bad.gz: unexpected end of file\n"


@pytest.mark.asyncio
async def test_trailing_warning_keeps_in_place_output_and_continues():
    files = {
        "/data/a.gz": gzip.compress(b"hello") + b"junk",
        "/data/b.gz": gzip.compress(b"world")
    }

    async def read(path):
        return files[path.virtual]

    async def write(path, data):
        files[path.virtual] = data

    async def unlink(path):
        del files[path.virtual]

    paths = [PathSpec.from_str_path(p) for p in files]
    _, io = await decompress_inputs(paths,
                                    command="gunzip",
                                    read=read,
                                    write=write,
                                    unlink=unlink)
    assert files == {"/data/a": b"hello", "/data/b": b"world"}
    assert io.exit_code == 2
    assert io.stderr == (b"gunzip: /data/a.gz: decompression OK, "
                         b"trailing garbage ignored\n")
