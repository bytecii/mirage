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

from mirage.commands.builtin.generic.crossmount.types import OperandRun
from mirage.commands.builtin.generic.wc import (WCCounts, format_count_rows,
                                                number_width, parse_flags,
                                                shown_counts)
from mirage.commands.spec.types import FlagValue

# GNU prints a row's counts in this order whichever flags ask for them.
_COLUMNS = ("lines", "words", "chars", "bytes_", "max_line_length")


def combine_wc(results: list[OperandRun],
               flag_kwargs: dict[str, FlagValue]) -> bytes:
    """Re-total per-operand wc rows with one shared column width.

    Each native run right-aligns its own rows against its own operands, so
    the runs cannot simply concatenate: rows are re-parsed and the whole
    report is reformatted by the same formatter the single-mount command
    uses, which is also what applies ``--total``. ``run_fanout`` forces the
    native runs to ``--total=never`` and to count bytes, so every line read
    here is a file row that carries its file's size, which is what GNU
    sizes the columns by; a byte column nobody asked for is not shown.

    Args:
        results (list[OperandRun]): Per-operand native wc runs.
        flag_kwargs (dict): Flags parsed against the shared wc spec.
    """
    flags = parse_flags(flag_kwargs)
    shown = {
        "lines": flags.lines,
        "words": flags.words,
        "chars": flags.chars,
        "bytes_": flags.bytes_,
        "max_line_length": flags.max_line_length,
    }
    if not any(shown.values()):
        shown.update(lines=True, words=True, bytes_=True)
    read = [c for c in _COLUMNS if shown[c] or c == "bytes_"]
    rows: list[tuple[WCCounts, str | None]] = []
    sizes: list[int | None] = []
    totals = WCCounts()
    for run in results:
        for line in run.data.decode(errors="replace").splitlines():
            parts = line.split(None, len(read))
            counts = WCCounts(**dict(zip(read, map(int, parts[:len(read)]))))
            label = parts[len(read)] if len(parts) > len(read) else None
            rows.append((counts, label))
            sizes.append(None if label in ("-",
                                           "/dev/stdin") else counts.bytes_)
            totals.merge(counts)
    # GNU decides the auto total on the operands *given*, not on the rows
    # that resolved, so a missing operand still gets a total row. There are
    # always at least two scopes here, and a glob operand can expand to more.
    operands = max(len(rows), len(results))
    width = number_width(sizes, operands, shown_counts(flags))
    return format_count_rows(rows, totals, operands, flags, width)
