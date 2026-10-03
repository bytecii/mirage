import asyncio
import unittest
from types import SimpleNamespace

from harness import run_case, validate_concurrent

from mirage.io import IOResult


def concurrent_case():
    worker = {
        "command": "worker",
        "expect": {
            "exit": 0,
            "stdout": "",
            "stderr": ""
        }
    }
    return {
        "command": "joined",
        "concurrent": [worker, dict(worker)],
        "expect": {
            "exit": 0,
            "stdout": "",
            "stderr": ""
        }
    }


class ConcurrentCases(unittest.IsolatedAsyncioTestCase):

    async def test_workers_overlap_before_join(self):
        started = 0
        ready = asyncio.Event()

        async def execute(command, **_opts):
            nonlocal started
            if command == "worker":
                started += 1
                if started == 2:
                    ready.set()
                await ready.wait()
            else:
                self.assertEqual(started, 2)
            return IOResult()

        result = await asyncio.wait_for(
            run_case(SimpleNamespace(execute=execute), concurrent_case()), 1)
        self.assertEqual(result[:3], (0, "", ""))

    async def test_worker_failure_cannot_be_hidden_by_join(self):

        async def execute(command, **_opts):
            self.assertEqual(command, "worker")
            return IOResult(exit_code=7)

        result = await run_case(SimpleNamespace(execute=execute),
                                concurrent_case())
        self.assertEqual(result[0], 1)
        self.assertIn("concurrent[0]: exit: expected 0, got 7", result[2])

    async def test_timeout_joins_workers(self):
        cleaned = 0

        async def execute(_command, **_opts):
            nonlocal cleaned
            try:
                await asyncio.Event().wait()
            finally:
                cleaned += 1

        case = concurrent_case()
        case["timeout_seconds"] = 0.01
        with self.assertRaises(asyncio.TimeoutError):
            await run_case(SimpleNamespace(execute=execute), case)
        self.assertEqual(cleaned, 2)

    def test_empty_group_is_refused(self):
        with self.assertRaisesRegex(ValueError, "at least two"):
            validate_concurrent({"concurrent": []})


if __name__ == "__main__":
    unittest.main()
