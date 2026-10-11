import re

import pytest

from mirage.utils.regex_scan import scan


@pytest.mark.parametrize(
    "restart,spans",
    [
        (False, [(0, 0), (0, 3), (3, 3)]),
        (True, [(0, 0), (1, 1), (2, 2), (3, 3)]),
    ],
)
def test_empty_matches_preserve_the_callers_iteration_rule(restart, spans):
    assert [
        found[0] for found in scan(re.compile("a*|b+"), "bbb", restart=restart)
    ] == spans


def test_first_match_mode_keeps_every_group_span():
    pattern = re.compile(r"(?P<letter>[ab])(x)?")
    assert scan(pattern, "aab", all_matches=False) == [
        ((0, 1), (0, 1), (-1, -1))
    ]
    assert scan(pattern, "none", all_matches=False) == []
