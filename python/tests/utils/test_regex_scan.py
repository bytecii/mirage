import re

import pytest

from mirage.utils.regex_scan import scan, scan_many


@pytest.mark.parametrize(
    "restart,spans",
    [
        (False, [(0, 0), (0, 3), (3, 3)]),
        (True, [(0, 0), (1, 1), (2, 2), (3, 3)]),
    ],
)
def test_empty_matches_preserve_the_callers_iteration_rule(restart, spans):
    assert [
        m.spans[0] for m in scan(re.compile("a*|b+"), "bbb", restart=restart)
    ] == spans


def test_batch_preserves_captures_and_first_match_mode():
    pattern = re.compile(r"(?P<letter>[ab])(x)?")
    first, empty = scan_many(pattern, ["aab", "none"], False, False)
    assert len(first) == 1
    assert first[0].group("letter") == "a"
    assert first[0].group(2) is None
    assert first[0].start() == 0
    assert empty == []
