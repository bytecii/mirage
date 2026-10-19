import sys
from concurrent.futures import ThreadPoolExecutor

import pytest

from mirage.rs.errors import RegexError
from mirage.rs.regex import LineRegex, PosixRegex, posix_escape, posix_regex


def _texts(regex: PosixRegex, subject: str) -> list[str | None]:
    found = regex.search(subject)
    assert found is not None
    return [None if span is None else subject[slice(*span)] for span in found]


@pytest.mark.parametrize(
    "pattern,subject,want",
    [
        # Leftmost-longest overall, groups by the first way to that end.
        ("(a|ab)(bc|c)", "abc", ["abc", "a", "bc"]),
        ("(ab|a)(bc|c)", "abc", ["abc", "ab", "c"]),
        ("(a|ab)*", "abab", ["abab", "ab"]),
        ("(a*)(ab)*(b*)", "aabab", ["aabab", "a", "ab", ""]),
        # An iteration that consumes nothing is never taken.
        ("(a*)+", "aa", ["aa", "aa"]),
        ("(a?)*", "aa", ["aa", "a"]),
        # A group inside a later iteration keeps what it took before.
        ("((a)|b)*", "ab", ["ab", "b", "a"]),
    ],
)
def test_groups_lie_where_glibc_puts_them(pattern, subject, want):
    assert _texts(PosixRegex(pattern, True, "sed"), subject) == want


def test_offsets_count_characters_of_the_view():
    regex = PosixRegex("é.", utf8=True)
    assert regex.search("aéb") == [(1, 3)]
    assert PosixRegex("\\(.\\)", utf8=False).search("\xc3\xa9") == [
        (0, 1),
        (0, 1),
    ]


def test_a_global_walk_passes_over_an_empty_match_where_one_ended():
    found = PosixRegex("a*", dialect="sed").all("baaac")
    assert [spans[0] for spans in found] == [(0, 0), (1, 4), (5, 5)]


@pytest.mark.parametrize(
    "pattern,extended,dialect",
    [
        ("a**", False, "sed"),
        ("*a", True, "sed"),
        ("\\{1\\}", False, "sed"),
        ("*a", True, "posix"),
    ],
)
def test_preceding_refusals_differ_by_dialect(pattern, extended, dialect):
    with pytest.raises(RegexError) as refused:
        PosixRegex(pattern, extended, dialect)
    assert refused.value.message == "Invalid preceding regular expression"


def test_regcomps_basic_syntax_takes_what_sed_refuses():
    assert PosixRegex("a**").search("aa") == [(0, 2)]
    assert PosixRegex("[z-a]x").search("x") is None
    with pytest.raises(RegexError, match="Invalid range end"):
        PosixRegex("[z-a]", dialect="sed")


def test_anchors_read_the_newlines_a_match_consumes():
    assert PosixRegex("a.^b", True, "sed").search("a\nb") == [(0, 3)]
    assert PosixRegex("^b", dialect="sed").search("a\nb") is None
    assert PosixRegex("b$.", True, "sed").search("b\nc") == [(0, 2)]
    assert PosixRegex("(b)$.", True, "sed").search("b\nc") is None
    assert PosixRegex("^b", dialect="sed", multiline=True).search("a\nb") == [
        (2, 3)
    ]


def test_dot_skips_nul_for_regcomp_only():
    assert PosixRegex("a.b").search("a\0b") is None
    assert PosixRegex("a[^x]b").search("a\0b") == [(0, 3)]
    assert PosixRegex("a.b", dialect="sed").search("a\0b") == [(0, 3)]


def test_classes_and_case_are_unicode_under_utf8():
    assert PosixRegex("[[:alpha:]]", utf8=True).search("-é") == [(1, 2)]
    assert PosixRegex("é", ignore_case=True, utf8=True).search("É")
    assert PosixRegex("[[:alpha:]]").search("\xc3\xa9") is None


def test_a_raw_byte_is_never_found_inside_a_character():
    regex = PosixRegex("\udca9", utf8=True)
    assert regex.search("é") is None
    assert regex.search("a\udca9") == [(1, 2)]


def test_word_wraps_the_match():
    regex = PosixRegex("ab|abc", True, word=True)
    assert regex.search("abcd abc") == [(5, 8)]


def test_posix_escape_matches_only_itself():
    text = "a.b*c[d]^$\\(e)"
    regex = PosixRegex(posix_escape(text), True)
    assert regex.search("x" + text) == [(1, 1 + len(text))]


def test_lines_select_and_extend_like_grep():
    regex = LineRegex(["ab|abcd", "x"], "extended", word=True)
    assert regex.matches("abcd y")
    assert not regex.matches("abcde")
    assert regex.extents("abcd x") == [(0, 4), (5, 6)]
    assert regex.needles == (b"ab", b"abcd", b"x")


def test_lines_carry_greps_warnings_and_refusals():
    assert LineRegex(["*a"], "extended").warnings == (
        "* at start of expression",
    )
    with pytest.raises(RegexError, match=r"Unmatched \( or \\\("):
        LineRegex(["\\(a"], "basic")


def test_unicode_folding_drops_needles_it_could_miss():
    assert LineRegex(["kelvin"], "fixed", True, True).needles is None
    assert LineRegex(["KELVIN"], "fixed", True).needles == (b"kelvin",)


def test_threads_sharing_one_expression_keep_their_subjects_apart():
    regex = posix_regex("^a.*z$", extended=True)
    lines = LineRegex(["^a.*z$"], "extended")
    subjects = [("a" + "x" * n + ("z" if n % 2 else "y")) for n in range(64)]
    want = [n % 2 == 1 for n in range(64)]

    def scan(_: int) -> bool:
        return all(
            (regex.search(text) is not None) == hit
            and lines.matches(text) == hit
            for text, hit in zip(subjects, want, strict=True)
        )

    interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        with ThreadPoolExecutor(8) as pool:
            assert all(pool.map(scan, range(64)))
    finally:
        sys.setswitchinterval(interval)
