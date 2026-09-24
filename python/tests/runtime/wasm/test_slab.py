# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import sys
import threading

import pytest

pytest.importorskip("wasmtime")

from wasmtime import _func  # noqa: E402
from wasmtime._slab import Slab  # noqa: E402

from mirage.runtime.wasm import slab  # noqa: E402

from mirage.runtime.wasm.slab import (  # noqa: E402  # isort: skip
    LockedSlab, install_slab_lock)


def _churn(table, tag: int, rounds: int, errors: list) -> None:
    """Allocate, read back and free one slot per round, as runs do.

    Args:
        table (LockedSlab | Slab): the slab under test.
        tag (int): this thread's id, part of every value it parks.
        rounds (int): how many slots to cycle.
        errors (list): what went wrong, appended in place.
    """
    try:
        for i in range(rounds):
            idx = table.allocate((tag, i))
            got = table.get(idx)
            if got != (tag, i):
                errors.append((tag, i, got))
            table.deallocate(idx)
    except Exception as exc:
        errors.append(exc)


def test_locked_slab_keeps_every_threads_callback_its_own():
    # The bare Slab loses a slot, or leaves a tuple as the free-list
    # head, in every one of these trials.
    before = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        for _ in range(5):
            table = LockedSlab(Slab())
            errors: list = []
            threads = [
                threading.Thread(target=_churn,
                                 args=(table, tag, 2000, errors))
                for tag in range(4)
            ]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            assert errors == []
    finally:
        sys.setswitchinterval(before)


class _CollectingSlab(Slab):
    """A slab whose next allocation runs a callback first, the way a
    garbage collection inside it fires a dropped store's destructor."""

    def __init__(self) -> None:
        super().__init__()
        self.on_allocate = None

    def allocate(self, val):
        hook, self.on_allocate = self.on_allocate, None
        if hook is not None:
            hook()
        return super().allocate(val)


def test_a_free_inside_an_allocation_is_deferred_not_deadlocked():
    inner = _CollectingSlab()
    table = LockedSlab(inner)
    first = table.allocate(("first", ))
    inner.on_allocate = lambda: table.deallocate(first)
    seen: dict = {}

    def allocate_twice() -> None:
        seen["second"] = table.allocate(("second", ))
        seen["first_still_parked"] = table.get(first)
        seen["third"] = table.allocate(("third", ))

    worker = threading.Thread(target=allocate_twice, daemon=True)
    worker.start()
    worker.join(5)
    assert not worker.is_alive()
    assert seen["second"] != first
    assert seen["first_still_parked"] == ("first", )
    assert seen["third"] == first


def test_install_wraps_the_func_table_once_and_keeps_its_slots(monkeypatch):
    table = Slab()
    parked = table.allocate(("parked", ))
    monkeypatch.setattr(_func, "FUNCTIONS", table)
    monkeypatch.setattr(slab, "_installed", False)
    install_slab_lock()
    locked = _func.FUNCTIONS
    assert isinstance(locked, LockedSlab)
    assert locked.get(parked) == ("parked", )
    install_slab_lock()
    assert _func.FUNCTIONS is locked


def test_install_stands_down_when_wasmtime_guards_the_slab(monkeypatch):
    table = Slab()
    monkeypatch.setattr(_func, "FUNCTIONS", table)
    monkeypatch.setattr(slab, "_installed", False)
    monkeypatch.setattr(slab.wasmtime_slab,
                        "threading",
                        threading,
                        raising=False)
    install_slab_lock()
    assert _func.FUNCTIONS is table
