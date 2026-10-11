import importlib
import pickle
import sys

from mirage.concurrency.worker import HEADER


def main() -> None:
    """Serve trusted computation requests from the parent over private pipes."""
    source, sink = sys.stdin.buffer, sys.stdout.buffer
    while header := source.read(HEADER.size):
        module, name, args = pickle.loads(
            source.read(HEADER.unpack(header)[0])
        )
        try:
            result = (
                True,
                getattr(importlib.import_module(module), name)(*args),
            )
        except Exception as exc:
            result = (False, exc)
        data = pickle.dumps(result)
        sink.write(HEADER.pack(len(data)) + data)
        sink.flush()


if __name__ == "__main__":
    main()
