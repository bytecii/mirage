import pytest


@pytest.mark.asyncio
async def test_stat_reports_file_metadata(onedrive_read_ws):
    io = await onedrive_read_ws.execute("stat /onedrive/words.txt")

    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "name=words.txt" in out
    assert "size=17" in out


@pytest.mark.asyncio
async def test_tree_renders_nested_entries(onedrive_read_ws):
    io = await onedrive_read_ws.execute("tree /onedrive/")

    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "words.txt" in out
    assert "inner.txt" in out


@pytest.mark.asyncio
async def test_find_filters_by_name(onedrive_read_ws):
    io = await onedrive_read_ws.execute("find /onedrive/ -name '*.json'")

    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "/onedrive/data.json" in out
    assert "/onedrive/data2.json" in out
    assert "words.txt" not in out
