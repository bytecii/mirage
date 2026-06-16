from mirage.agents.io_text import decode, io_to_str
from mirage.io.types import IOResult


def test_decode_none_returns_empty():
    assert decode(None) == ""


def test_decode_bytes():
    assert decode(b"hello") == "hello"


def test_decode_invalid_utf8_replaces():
    assert decode(b"\xff") == "�"


def test_io_to_str_stdout_only():
    assert io_to_str(IOResult(stdout=b"out")) == "out"


def test_io_to_str_stderr_only():
    assert io_to_str(IOResult(stderr=b"err")) == "err"


def test_io_to_str_combines_stdout_and_stderr():
    assert io_to_str(IOResult(stdout=b"out", stderr=b"err")) == "out\nerr"


async def _stream():
    yield b"streamed"


def test_io_to_str_ignores_unmaterialized_stream():
    assert io_to_str(IOResult(stdout=_stream())) == ""
