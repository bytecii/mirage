import pytest

from mirage.core.slug_tree.read import join_lines


async def _parts():
    for part in ("a", "b", "c"):
        yield part


@pytest.mark.asyncio
async def test_join_lines_puts_a_newline_between_parts():
    assert b"".join([c async for c in join_lines(_parts())]) == b"a\nb\nc"
