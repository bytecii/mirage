import pytest


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command",
    [
        "cp /onedrive/words.txt /onedrive/copy.txt",
        "mv /onedrive/words.txt /onedrive/moved.txt",
        "rm /onedrive/words.txt",
        "mkdir /onedrive/newdir",
        "touch /onedrive/created.txt",
    ],
)
async def test_write_commands_rejected_on_read_mount(onedrive_read_ws,
                                                     onedrive_files, command):
    io = await onedrive_read_ws.execute(command)

    assert io.exit_code != 0
    assert b"read-only" in io.stderr
    assert "/copy.txt" not in onedrive_files.files
    assert "/moved.txt" not in onedrive_files.files
    assert "/created.txt" not in onedrive_files.files
    assert "/newdir" not in onedrive_files.dirs
    assert "/words.txt" in onedrive_files.files


@pytest.mark.asyncio
async def test_cp_copies_file_and_reports_mount_relative_write(
        onedrive_write_ws, onedrive_files):
    io = await onedrive_write_ws.execute(
        "cp /onedrive/words.txt /onedrive/copy.txt")

    assert io.exit_code == 0
    assert onedrive_files.files["/copy.txt"] == b"beta\nalpha\nalpha\n"
    assert "/onedrive/copy.txt" in io.writes
    assert "/onedrive/onedrive/copy.txt" not in io.writes


@pytest.mark.asyncio
async def test_mv_moves_file(onedrive_write_ws, onedrive_files):
    io = await onedrive_write_ws.execute(
        "mv /onedrive/words.txt /onedrive/moved.txt")

    assert io.exit_code == 0
    assert "/words.txt" not in onedrive_files.files
    assert onedrive_files.files["/moved.txt"] == b"beta\nalpha\nalpha\n"


@pytest.mark.asyncio
async def test_rm_recursive_removes_directory_tree(onedrive_write_ws,
                                                   onedrive_files):
    io = await onedrive_write_ws.execute("rm -r /onedrive/sub")

    assert io.exit_code == 0
    assert "/sub" not in onedrive_files.dirs
    assert "/sub/inner.txt" not in onedrive_files.files
    assert "/onedrive/sub" in io.writes


@pytest.mark.asyncio
async def test_plain_rm_on_directory_fails(onedrive_write_ws, onedrive_files):
    io = await onedrive_write_ws.execute("rm /onedrive/sub")

    assert io.exit_code != 0
    assert "/sub" in onedrive_files.dirs
    assert "/sub/inner.txt" in onedrive_files.files


@pytest.mark.asyncio
async def test_mkdir_creates_directory(onedrive_write_ws, onedrive_files):
    io = await onedrive_write_ws.execute("mkdir /onedrive/newdir")

    assert io.exit_code == 0
    assert "/newdir" in onedrive_files.dirs


@pytest.mark.asyncio
async def test_touch_creates_missing_file(onedrive_write_ws, onedrive_files):
    io = await onedrive_write_ws.execute("touch /onedrive/created.txt")

    assert io.exit_code == 0
    assert onedrive_files.files["/created.txt"] == b""
