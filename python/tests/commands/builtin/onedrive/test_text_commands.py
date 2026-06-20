import pytest


@pytest.mark.asyncio
async def test_sort_orders_file_lines(onedrive_read_ws):
    io = await onedrive_read_ws.execute("sort /onedrive/words.txt")

    assert io.exit_code == 0
    assert io.stdout == b"alpha\nalpha\nbeta\n"


@pytest.mark.asyncio
async def test_cut_extracts_csv_field(onedrive_read_ws):
    io = await onedrive_read_ws.execute("cut -d, -f1 /onedrive/table.csv")

    assert io.exit_code == 0
    assert io.stdout == b"name\nann\nbob\n"


@pytest.mark.asyncio
async def test_tr_translates_streamed_file(onedrive_read_ws):
    io = await onedrive_read_ws.execute("tr a A /onedrive/more.txt")

    assert io.exit_code == 0
    assert io.stdout == b"deltA\n"


@pytest.mark.asyncio
async def test_uniq_collapses_adjacent_lines(onedrive_read_ws):
    io = await onedrive_read_ws.execute("uniq /onedrive/words.txt")

    assert io.exit_code == 0
    assert io.stdout == b"beta\nalpha\n"


@pytest.mark.asyncio
async def test_jq_reads_json_file(onedrive_read_ws):
    io = await onedrive_read_ws.execute("jq .name /onedrive/data.json")

    assert io.exit_code == 0
    assert "mirage" in io.stdout.decode()
