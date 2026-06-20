import asyncio
from datetime import datetime, timezone

import pytest

from mirage.core.databricks_volume.stat import (_modified,
                                                _name_from_backend_path, stat)
from mirage.types import FileType, PathSpec

from .conftest import ToThreadRecorder, file_metadata


def test_modified_none_and_empty_string_return_none():
    assert _modified(None) is None
    assert _modified("") is None


def test_modified_parses_http_date_to_iso_utc():
    assert _modified(
        "Tue, 14 Nov 2023 22:13:20 GMT") == "2023-11-14T22:13:20+00:00"


def test_modified_returns_unparseable_string_verbatim():
    assert _modified("not a date") == "not a date"


def test_modified_coerces_naive_datetime_to_utc():
    naive = datetime(2023, 11, 14, 22, 13, 20)
    assert _modified(naive) == "2023-11-14T22:13:20+00:00"


def test_modified_converts_aware_datetime_to_utc():
    aware = datetime(2023, 11, 14, 22, 13, 20, tzinfo=timezone.utc)
    assert _modified(aware) == "2023-11-14T22:13:20+00:00"


def test_modified_treats_large_int_as_epoch_milliseconds():
    assert _modified(1_700_000_000_000) == "2023-11-14T22:13:20+00:00"


def test_name_from_backend_path_file():
    assert _name_from_backend_path(
        "/Volumes/main/default/agent_files/root/latest.md") == "latest.md"


def test_name_from_backend_path_directory_with_trailing_slash():
    assert _name_from_backend_path(
        "/Volumes/main/default/agent_files/root/reports/") == "reports"


@pytest.mark.asyncio
async def test_stat_file(accessor, files, remote_root):
    files.metadata[f"{remote_root}/reports/latest.md"] = file_metadata(
        size=6,
        modified="Tue, 14 Nov 2023 22:13:20 GMT",
    )
    path = PathSpec.from_str_path("/volume/reports/latest.md", "/volume")
    result = await stat(accessor, path)
    assert result.name == "latest.md"
    assert result.size == 6
    assert result.modified == "2023-11-14T22:13:20+00:00"
    assert result.type != FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_root_does_not_call_sdk(accessor, files):
    path = PathSpec.from_str_path("/volume", "/volume")
    result = await stat(accessor, path)
    assert result.name == "/"
    assert result.type == FileType.DIRECTORY
    assert files.get_metadata_calls == []
    assert files.get_directory_metadata_calls == []


@pytest.mark.asyncio
async def test_stat_directory_uses_directory_metadata_fallback(
    accessor,
    files,
    remote_root,
):
    files.directory_metadata.add(f"{remote_root}/reports")
    path = PathSpec.from_str_path("/volume/reports", "/volume")
    result = await stat(accessor, path)
    assert result.name == "reports"
    assert result.size is None
    assert result.type == FileType.DIRECTORY
    assert files.get_metadata_calls == [f"{remote_root}/reports"]
    assert files.get_directory_metadata_calls == [f"{remote_root}/reports"]


@pytest.mark.asyncio
async def test_stat_missing_path_raises(accessor):
    path = PathSpec.from_str_path("/volume/missing", "/volume")
    with pytest.raises(FileNotFoundError):
        await stat(accessor, path)


@pytest.mark.asyncio
async def test_stat_missing_path_checks_directory_metadata(
    accessor,
    files,
    remote_root,
):
    path = PathSpec.from_str_path("/volume/missing", "/volume")
    with pytest.raises(FileNotFoundError):
        await stat(accessor, path)
    assert files.get_metadata_calls == [f"{remote_root}/missing"]
    assert files.get_directory_metadata_calls == [f"{remote_root}/missing"]


@pytest.mark.asyncio
async def test_stat_rejects_path_escape(accessor):
    path = PathSpec.from_str_path("/volume/../outside", "/volume")
    with pytest.raises(ValueError, match="escapes Databricks volume root"):
        await stat(accessor, path)


@pytest.mark.asyncio
async def test_stat_metadata_error_propagates(accessor, files, remote_root):
    remote_path = f"{remote_root}/reports"
    files.metadata_errors[remote_path] = RuntimeError("metadata failed")
    path = PathSpec.from_str_path("/volume/reports", "/volume")
    with pytest.raises(RuntimeError, match="metadata failed"):
        await stat(accessor, path)
    assert files.get_metadata_calls == [remote_path]
    assert files.get_directory_metadata_calls == []


@pytest.mark.asyncio
async def test_stat_directory_metadata_error_propagates(
    accessor,
    files,
    remote_root,
):
    remote_path = f"{remote_root}/reports"
    files.directory_metadata_errors[remote_path] = RuntimeError(
        "directory metadata failed")
    path = PathSpec.from_str_path("/volume/reports", "/volume")
    with pytest.raises(RuntimeError, match="directory metadata failed"):
        await stat(accessor, path)
    assert files.get_metadata_calls == [remote_path]
    assert files.get_directory_metadata_calls == [remote_path]


@pytest.mark.asyncio
async def test_stat_runs_blocking_metadata_off_event_loop(
    accessor,
    files,
    remote_root,
    monkeypatch,
):
    to_thread = ToThreadRecorder()
    monkeypatch.setattr(asyncio, "to_thread", to_thread)
    files.metadata[f"{remote_root}/reports/latest.md"] = file_metadata(size=6)
    path = PathSpec.from_str_path("/volume/reports/latest.md", "/volume")

    result = await stat(accessor, path)

    assert result.name == "latest.md"
    assert len(to_thread.calls) == 1


@pytest.mark.asyncio
async def test_stat_directory_fallback_runs_off_event_loop(
    accessor,
    files,
    remote_root,
    monkeypatch,
):
    to_thread = ToThreadRecorder()
    monkeypatch.setattr(asyncio, "to_thread", to_thread)
    files.directory_metadata.add(f"{remote_root}/reports")
    path = PathSpec.from_str_path("/volume/reports", "/volume")

    result = await stat(accessor, path)

    assert result.type == FileType.DIRECTORY
    assert len(to_thread.calls) == 2
