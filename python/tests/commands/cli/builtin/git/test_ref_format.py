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

import pytest

from mirage.commands.cli.builtin.git import ref_format
from mirage.commands.cli.builtin.git.errors import (
    FormatUsageError,
    GitError,
    UnparsableFormatError,
)
from mirage.commands.cli.builtin.git.types import (
    DateMode,
    QuoteStyle,
    RefContext,
    RefItem,
    RefKind,
    RefObject,
)
from mirage.shell.bytes import encode_text

# Every expectation below is git's own output for the same refs, measured
# with git 2.47.3 and 2.50.1.


def _commit(when: int, subject: str) -> RefObject:
    """A commit object with one date and subject.

    Args:
        when (int): the author and committer timestamp.
        subject (str): the message.
    """
    return RefObject(
        oid=f"{when:040d}",
        type="commit",
        raw=f"tree {'t' * 40}\n"
        f"author A <a@x> {when} +0000\n"
        f"committer C <c@x> {when} +0000\n\n"
        f"{subject}\n".encode(),
    )


BLOB = RefObject(oid="b" * 40, type="blob", raw=b"x")
ITEMS = [
    RefItem(
        name="refs/heads/a",
        oid="1" * 40,
        kind=RefKind.BRANCH,
        obj=_commit(300, "three"),
    ),
    RefItem(
        name="refs/heads/b",
        oid="2" * 40,
        kind=RefKind.BRANCH,
        obj=_commit(100, "one"),
    ),
    RefItem(name="refs/tags/blob", oid="b" * 40, kind=RefKind.TAG, obj=BLOB),
    RefItem(
        name="refs/tags/c",
        oid="3" * 40,
        kind=RefKind.TAG,
        obj=_commit(300, "tie"),
    ),
]
CTX = RefContext(date=DateMode(now=0))
# Three refs dated within one day, so a short date ties them all.
DATED = [
    RefItem(
        name=f"refs/tags/{n}",
        oid=f"{i:040d}",
        kind=RefKind.TAG,
        obj=_commit(when, n),
    )
    for i, (n, when) in enumerate([("a10", 1300), ("a9", 1400), ("v2.0", 900)])
]


def _run(
    template: str, keys: tuple[str, ...] | None = ("refname",), **kwargs
) -> tuple[str, str | None]:
    """Format the fixture refs, returning what printed and the refusal.

    Args:
        template (str): the format.
        keys (tuple[str, ...] | None): sort keys in line order.
    """
    out, stopped = ref_format.format_refs(
        ref_format.parse_format(template),
        kwargs.pop("items", ITEMS),
        CTX,
        ref_format.parse_sort_keys(keys) if keys else None,
        **kwargs,
    )
    return out, None if stopped is None else str(stopped)


@pytest.mark.parametrize(
    "text,expected",
    [
        ("100%%", "100%"),
        ("%41%4g", "A%4g"),
        ("50% off", "50% off"),
        ("%", "%"),
        ("x%", "x%"),
    ],
)
def test_literal_text_expands_percent_escapes(text, expected):
    assert ref_format.literal_text(text) == expected


def test_a_hex_escape_names_a_raw_byte():
    assert encode_text(ref_format.literal_text("%ff%00")) == b"\xff\x00"


def test_a_quoted_percent_never_opens_a_field():
    assert ref_format.parse_format("%%(refname)").pieces == ("%(refname)",)
    assert [
        p if isinstance(p, str) else p.text
        for p in ref_format.parse_format("%%%(refname)").pieces
    ] == [
        "%",
        "refname",
    ]


def test_an_unclosed_field_is_a_usage_error_or_a_listing_fatal():
    with pytest.raises(FormatUsageError) as info:
        ref_format.parse_format("x %(refname")
    assert str(info.value) == "malformed format string %(refname"
    with pytest.raises(UnparsableFormatError) as listing:
        ref_format.listing_format("x %(refname")
    assert (
        str(listing.value)
        == "malformed format string %(refname\nfatal: unable to parse format string"
    )


def test_raw_is_refused_under_a_quoting_that_cannot_carry_bytes():
    for spelling in ("raw", "*raw"):
        with pytest.raises(GitError) as quoted:
            ref_format.parse_format(f"%({spelling})", QuoteStyle.SHELL)
        assert (
            str(quoted.value)
            == f"--format={spelling} cannot be used with --python, --shell, --tcl"
        )
    assert ref_format.parse_format("%(raw)", QuoteStyle.PERL).pieces
    assert ref_format.parse_format("%(raw:size)", QuoteStyle.SHELL).pieces


def test_the_last_sort_key_given_sorts_first():
    keys = ref_format.parse_sort_keys(
        ["refname", "-v:objecttype", "version:tag"]
    )
    assert [(k.field.name, k.reverse, k.version) for k in keys] == [
        ("tag", False, True),
        ("objecttype", True, True),
        ("refname", False, False),
    ]
    with pytest.raises(GitError) as info:
        ref_format.parse_sort_keys(["v:-refname"])
    assert str(info.value) == "unknown field name: -refname"


@pytest.mark.parametrize(
    "suffixes,names",
    [
        ((), ["v1.0", "v1.0-rc1", "v1.0.1", "v1.2", "v1.10"]),
        (("-rc",), ["v1.0-rc1", "v1.0-rc2", "v1.0", "v1.0.1"]),
        (("-rc", "-beta"), ["v2.0-rc1", "v2.0-beta", "v2.0", "v2.0.0"]),
        (("-rc", "0"), ["release-1.0", "release-1.0-rc"]),
        (("-pre", "", "-post"), ["v1-pre", "v1", "v1-post"]),
        (("-rc", "-rc1"), ["v1.0-rc2", "v1.0-rc1", "v1.0"]),
    ],
)
def test_versioncmp_places_configured_suffixes(suffixes, names):
    for a, b in zip(names, names[1:]):
        assert ref_format.versioncmp(a, b, suffixes) < 0
        assert ref_format.versioncmp(b, a, suffixes) > 0


@pytest.mark.parametrize(
    "style,text,expected",
    [
        (QuoteStyle.SHELL, "it's!!", "'it'\\''s'\\!''\\!''"),
        (QuoteStyle.PERL, "it's!\\", "'it\\'s!\\\\'"),
        (QuoteStyle.PYTHON, "it's!\\\n\t", "'it\\'s!\\\\\\n\t'"),
        (
            QuoteStyle.TCL,
            '[a]{b}$"\\\n\t\x01',
            '"\\[a\\]\\{b\\}\\$\\"\\\\\\n\\t\x01"',
        ),
    ],
)
def test_each_quote_style(style, text, expected):
    assert ref_format.quote_text(text, style) == expected


def test_blocks_nest_and_quote_as_a_whole():
    fmt = ref_format.parse_format(
        "%(if:equals=blob)%(objecttype)%(then)[%(align:6,right)%(refname:lstrip=2)%(end)]%(else)%(subject)%(end)",
        QuoteStyle.SHELL,
    )
    rows, _ = ref_format.format_refs(fmt, ITEMS[1:3], CTX, None)
    assert rows == "'one'\n'[  blob]'\n"


def test_a_plain_if_is_false_on_white_space_alone():
    assert _run("%(if) %(then)y%(else)n%(end)", items=ITEMS[:1]) == (
        "n\n",
        None,
    )


def test_align_pads_by_display_width():
    fmt = ref_format.parse_format(
        "%(align:6)Ærø%(end)|%(align:6,middle)日本%(end)|%(align:7,middle)ab%(end)|"
    )
    assert (
        ref_format.render_row(fmt, ITEMS[0], ref_format.ValueTable((), CTX))
        == "Ærø   | 日本 |  ab   |"
    )


@pytest.mark.parametrize(
    "template,message",
    [
        ("%(then)", "format: %(then) atom used without a %(if) atom"),
        ("%(else)", "format: %(else) atom used without a %(if) atom"),
        ("%(end)", "format: %(end) atom used without corresponding atom"),
        ("%(if)", "format: %(end) atom missing"),
        ("%(if)%(end)", "format: %(if) atom used without a %(then) atom"),
        ("%(if)%(else)", "format: %(else) atom used without a %(then) atom"),
        ("%(if)x%(then)y%(then)", "format: %(then) atom used more than once"),
        (
            "%(if)x%(then)y%(else)z%(else)",
            "format: %(else) atom used more than once",
        ),
        (
            "%(if)a%(align:3)%(then)b%(end)%(end)",
            "format: %(then) atom used without a %(if) atom",
        ),
        (
            "%(align:3)%(if)a%(end)%(then)b%(end)",
            "format: %(if) atom used without a %(then) atom",
        ),
    ],
)
def test_blocks_that_do_not_nest_are_refused_where_a_row_renders(
    template, message
):
    assert _run(template) == ("", message)
    assert _run(template, items=[]) == ("", None)


def test_keys_sort_with_names_breaking_ties_unreversed():
    out, _ = _run("%(refname)", ("-committerdate",))
    assert out == "refs/heads/a\nrefs/tags/c\nrefs/heads/b\nrefs/tags/blob\n"


def test_a_styled_date_key_compares_instants_only_in_the_first_comparison():
    assert (
        _run("%(refname:lstrip=2)", ("authordate:short",), items=DATED)[0]
        == "a10\nv2.0\na9\n"
    )
    assert (
        _run("%(refname:lstrip=2)", ("-authordate:short",), items=DATED)[0]
        == "a10\na9\nv2.0\n"
    )
    assert (
        _run("%(refname:lstrip=2)", ("authordate",), items=DATED)[0]
        == "v2.0\na10\na9\n"
    )


@pytest.mark.parametrize(
    "keys,expected",
    [
        (("authordate:short", "authordate:short"), "a10\nv2.0\na9\n"),
        (("authordate:short", "committerdate:short"), "a10\nv2.0\na9\n"),
        (("committerdate:short", "v:authordate:short"), "a10\na9\nv2.0\n"),
    ],
)
def test_the_first_comparison_is_the_sorts_whatever_key_makes_it(
    keys, expected
):
    assert _run("%(refname:lstrip=2)", keys, items=DATED)[0] == expected


def test_a_numeric_key_and_count_and_omit_empty():
    out, _ = _run(
        "%(if)%(subject)%(then)%(subject)%(end)",
        ("objectsize",),
        count=3,
        omit_empty=True,
    )
    # The count takes the empty blob row too, as git's does.
    assert out == "one\ntie\n"


def test_a_streamed_listing_stops_where_a_field_fails():
    out, stopped = _run(
        "%(refname) %(authordate:bogus)", items=[ITEMS[2], ITEMS[0]]
    )
    assert (out, stopped) == ("refs/tags/blob \n", "unknown date format bogus")
    assert _run(
        "%(refname) %(authordate:bogus)", count=1, items=[ITEMS[2], ITEMS[0]]
    ) == ("refs/tags/blob \n", None)


def test_a_ref_refuses_a_field_no_comparison_reads():
    refused = ("", "unknown date format bogus")
    assert (
        _run("%(refname)", ("authordate:bogus",), items=ITEMS[:1]) == refused
    )
    assert (
        _run("%(refname)", ("authordate:bogus", "refname"), items=ITEMS[:2])
        == refused
    )
    # A blob has no author date to refuse.
    assert _run("%(refname)", ("authordate:bogus",), items=ITEMS[2:3]) == (
        "refs/tags/blob\n",
        None,
    )


def test_ignore_case_sorts_even_the_default_order():
    items = [
        RefItem(
            name=f"refs/heads/{name}",
            oid="1" * 40,
            kind=RefKind.BRANCH,
            obj=_commit(1, "x"),
        )
        for name in ("B", "a")
    ]
    assert _run("%(refname)", count=1, items=items) == ("refs/heads/B\n", None)
    assert _run("%(refname)", count=1, icase=True, items=items) == (
        "refs/heads/a\n",
        None,
    )
    # --no-sort keeps the order the refs came in.
    assert _run("%(refname)", None, icase=True, items=items) == (
        "refs/heads/B\nrefs/heads/a\n",
        None,
    )


def test_a_sorted_listing_renders_every_row_before_it_prints():
    for count in (0, 1):
        out, stopped = _run(
            "%(refname) %(authordate:bogus)",
            ("-refname",),
            count=count,
            items=[ITEMS[0], ITEMS[2]],
        )
        assert (out, stopped) == ("", "unknown date format bogus")


def test_a_detached_head_leads_when_asked():
    head = RefItem(
        name="HEAD", oid="1" * 40, kind=RefKind.DETACHED, obj=_commit(1, "x")
    )
    out, _ = _run(
        "%(refname:short)",
        ("-refname",),
        items=[*ITEMS[:2], head],
        detached_first=True,
        stream=False,
    )
    assert out.splitlines()[0] == ""
