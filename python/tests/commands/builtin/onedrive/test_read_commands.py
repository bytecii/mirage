import pytest


@pytest.mark.asyncio
async def test_cat_reads_single_file_and_records_mount_relative_read(
        onedrive_read_ws):
    io = await onedrive_read_ws.execute("cat /onedrive/words.txt")

    assert io.exit_code == 0
    assert io.stdout == b"beta\nalpha\nalpha\n"
    assert "/onedrive/words.txt" in io.reads
    assert "/onedrive/onedrive/words.txt" not in io.reads


@pytest.mark.asyncio
async def test_cat_reads_multiple_globbed_files(onedrive_read_ws):
    io = await onedrive_read_ws.execute("cat /onedrive/data*.json")

    assert io.exit_code == 0
    out = io.stdout.decode()
    assert '"mirage"' in out
    assert '"agent"' in out


@pytest.mark.asyncio
async def test_head_and_tail_stream_file_content(onedrive_read_ws):
    head = await onedrive_read_ws.execute("head -n 1 /onedrive/words.txt")
    tail = await onedrive_read_ws.execute("tail -n 1 /onedrive/words.txt")

    assert head.exit_code == 0
    assert tail.exit_code == 0
    assert head.stdout == b"beta\n"
    assert tail.stdout == b"alpha\n"


@pytest.mark.asyncio
async def test_wc_counts_multiple_files(onedrive_read_ws):
    io = await onedrive_read_ws.execute(
        "wc /onedrive/words.txt /onedrive/more.txt")

    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "/onedrive/words.txt" in out
    assert "/onedrive/more.txt" in out
    assert "total" in out


@pytest.mark.asyncio
async def test_grep_searches_globbed_files(onedrive_read_ws):
    io = await onedrive_read_ws.execute("grep mirage /onedrive/*.json")

    assert io.exit_code == 0
    assert '"mirage"' in io.stdout.decode()


@pytest.mark.asyncio
async def test_rg_reports_no_match_exit_code(onedrive_read_ws):
    io = await onedrive_read_ws.execute("rg absent /onedrive/*.txt")

    assert io.exit_code != 0
