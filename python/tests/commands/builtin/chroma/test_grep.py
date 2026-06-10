import pytest

from mirage.commands.builtin.chroma.grep import grep
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_chroma_grep_command_uses_optimized_core(monkeypatch):
    calls = []

    async def fake_resolve_glob(accessor, paths, index):
        return paths

    async def fake_grep_bytes(accessor, paths, pattern, index, **kwargs):
        calls.append((paths, pattern, index, kwargs))
        return b"/knowledge/a:match", {"/knowledge/a": b"match"}

    monkeypatch.setitem(grep.__wrapped__.__globals__, "resolve_glob",
                        fake_resolve_glob)
    monkeypatch.setitem(grep.__wrapped__.__globals__, "grep_bytes",
                        fake_grep_bytes)

    path = PathSpec.from_str_path("/knowledge/a", "/knowledge/")
    index = object()
    output, io = await grep(object(), [path],
                            "match",
                            i=True,
                            n=True,
                            index=index)

    assert output == b"/knowledge/a:match"
    assert io.reads == {"/knowledge/a": b"match"}
    assert io.cache == ["/knowledge/a"]
    assert calls[0][1] == "match"
    assert calls[0][2] is index
    assert calls[0][3]["ignore_case"] is True
    assert calls[0][3]["line_numbers"] is True
