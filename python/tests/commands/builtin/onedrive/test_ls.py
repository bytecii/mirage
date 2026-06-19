import pytest


@pytest.mark.asyncio
async def test_ls_lists_entries(onedrive_read_ws):
    io = await onedrive_read_ws.execute("ls /onedrive/")

    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "words.txt" in out
    assert "sub" in out
    assert ".hidden" not in out


@pytest.mark.asyncio
async def test_ls_a_includes_hidden(onedrive_read_ws):
    io = await onedrive_read_ws.execute("ls -a /onedrive/")

    assert io.exit_code == 0
    assert ".hidden" in io.stdout.decode()


@pytest.mark.asyncio
async def test_ls_long_includes_size(onedrive_read_ws):
    io = await onedrive_read_ws.execute("ls -l /onedrive/")

    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "words.txt" in out
    assert "17" in out


@pytest.mark.asyncio
async def test_ls_recursive_descends_subdirs(onedrive_read_ws):
    io = await onedrive_read_ws.execute("ls -R /onedrive/")

    assert io.exit_code == 0
    assert "inner.txt" in io.stdout.decode()


@pytest.mark.asyncio
async def test_ls_missing_path_warns(onedrive_read_ws):
    io = await onedrive_read_ws.execute("ls /onedrive/missing")

    assert io.exit_code != 0
