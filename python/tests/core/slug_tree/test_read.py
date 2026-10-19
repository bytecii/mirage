import pytest

from mirage.core.slug_tree.read import join_lines


@pytest.mark.asyncio
async def test_join_lines_puts_a_newline_between_parts():
    async def parts():
        for part in ("a", "b", "c"):
            yield part

    assert b"".join([c async for c in join_lines(parts())]) == b"a\nb\nc"
