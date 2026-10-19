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

from dataclasses import replace

import pytest

from mirage.commands.cli.builtin.git import ref_fields
from mirage.commands.cli.builtin.git.errors import (
    GitError,
    UnknownDateFormatError,
    UnsupportedFieldError,
)
from mirage.commands.cli.builtin.git.types import (
    DateMode,
    MailmapEntry,
    RefContext,
    RefItem,
    RefKind,
    RefObject,
    RefUpstream,
)

# Every expectation below is git's own output for the same objects,
# measured with git 2.47.3 and 2.50.1.
COMMIT = RefObject(
    oid="c" * 40,
    type="commit",
    raw=(
        b"tree "
        + b"t" * 40
        + b"\nparent "
        + b"p" * 40
        + b"\nauthor A U Thor <author@example.com> 1584244800 +0530\n"
        b"committer C O Mitter <committer@example.com> 1584381600 -0800\n"
        b"\nSubject line\nwraps\n\nBody one.\nBody two.\n"
    ),
)
TAG = RefObject(
    oid="a" * 40,
    type="tag",
    raw=(
        b"object " + b"c" * 40 + b"\ntype commit\ntag v1\n"
        b"tagger T Agger <tagger@example.com> 1600000000 +0000\n\n"
        b"Release notes\n\nMore.\n-----BEGIN PGP SIGNATURE-----\nsig\n"
        b"-----END PGP SIGNATURE-----\n"
    ),
)
BLOB = RefObject(oid="b" * 40, type="blob", raw=b"data\n")
CTX = RefContext(
    known=frozenset({"refs/heads/main", "refs/tags/main"}),
    head="refs/heads/main",
    abbrev=7,
    date=DateMode(now=1700000000),
)


def _value(
    name: str,
    obj: RefObject | None = COMMIT,
    ref: str = "refs/heads/main",
    ctx: RefContext = CTX,
    **kwargs,
) -> str:
    """One field's text for a ref holding ``obj``.

    Args:
        name (str): the field as typed.
        obj (RefObject | None): the ref's object.
        ref (str): the ref's name.
        ctx (RefContext): the listing's facts.
    """
    item = RefItem(
        name=ref,
        oid=obj.oid if obj else "0" * 40,
        kind=RefKind.TAG if ref.startswith("refs/tags/") else RefKind.BRANCH,
        obj=obj,
        **kwargs,
    )
    return ref_fields.field_value(ref_fields.parse_field(name), item, ctx).text


@pytest.mark.parametrize(
    "name,message",
    [
        ("", "malformed field name: "),
        ("*", "malformed field name: *"),
        (":x", "unknown field name: :x"),
        ("bogus:x", "unknown field name: bogus:x"),
        ("**refname", "unknown field name: **refname"),
        ("creatorname", "unknown field name: creatorname"),
        ("refname:bogus", "unrecognized %(refname) argument: bogus"),
        ("*refname:bogus", "unrecognized %(*refname) argument: bogus"),
        ("*tree:x", "unrecognized %(*tree) argument: x"),
        ("*authoremail:x", "unrecognized %(*authoremail) argument: x"),
        ("*subject:x", "unrecognized %(subject) argument: x"),
        ("*objecttype:x", "%(objecttype) does not take arguments"),
        ("body:x", "%(body) does not take arguments"),
        ("refname:lstrip=x", "Integer value expected refname:lstrip=x"),
        ("symref:strip=x", "Integer value expected refname:lstrip=x"),
        ("upstream:rstrip=1 ", "Integer value expected refname:rstrip=1 "),
        (
            "refname:lstrip=2147483648",
            "Integer value expected refname:lstrip=2147483648",
        ),
        (
            "objectname:short=0",
            "positive value expected '0' in %(objectname:short=0)",
        ),
        (
            "*objectname:short=-1",
            "positive value expected '-1' in %(*objectname:short=-1)",
        ),
        ("contents:lines=x", "positive value expected contents:lines=x"),
        ("contents:size=1", "unrecognized %(contents) argument: size=1"),
        ("authoremail:trimfoo", "unrecognized %(authoremail) argument: foo"),
        ("authoremail:trim,", "unrecognized %(authoremail) argument: "),
        ("authoremail:,trim", "unrecognized %(authoremail) argument: ,trim"),
        (
            "authorname:mailmap,x",
            "unrecognized %(authorname) argument: mailmap,x",
        ),
        (
            "upstream:short,track",
            "unrecognized %(upstream) argument: short,track",
        ),
        ("upstream:track,", "unrecognized %(upstream) argument: track,"),
        ("align", "expected format: %(align:<width>,<position>)"),
        ("align:left", "positive width expected with the %(align) atom"),
        ("align:5,up", "unrecognized %(align) argument: up"),
        ("align:position=up,5", "unrecognized position:up"),
        ("align:width=-1", "unrecognized width:-1"),
        ("align:5 ", "unrecognized %(align) argument: 5 "),
        ("align:5,", "unrecognized %(align) argument: "),
        ("if:equals", "unrecognized %(if) argument: equals"),
        ("rest", "this command reject atom %(rest)"),
        ("rest:", "this command reject atom %(rest:)"),
        ("rest:x", "%(rest) does not take arguments"),
        ("deltabase:short", "%(deltabase) does not take arguments"),
        ("is-base", "expected format: %(is-base:<committish>)"),
        ("color", "expected format: %(color:<color>)"),
    ],
)
def test_a_field_is_refused_in_gits_words(name, message):
    with pytest.raises(GitError) as info:
        ref_fields.parse_field(name)
    assert str(info.value) == message


@pytest.mark.parametrize(
    "name",
    [
        "describe",
        "trailers",
        "contents:trailers",
        "push",
        "color:red",
        "objectsize:disk",
        "flag",
    ],
)
def test_a_field_this_build_lacks_is_unsupported_not_unknown(name):
    with pytest.raises(UnsupportedFieldError):
        ref_fields.parse_field(name)


@pytest.mark.parametrize(
    "text,expected",
    [
        ("2", 2),
        (" +3", 3),
        ("-4", -4),
        ("", None),
        ("2 ", None),
        ("0x1", None),
        ("2147483648", None),
    ],
)
def test_c_int_reads_a_32_bit_integer(text, expected):
    assert ref_fields.c_int(text) == expected


@pytest.mark.parametrize(
    "text,expected",
    [
        ("7", 7),
        (" +7", 7),
        ("-7", None),
        ("7x", None),
        ("2147483648", -2147483648),
        ("4294967296", None),
    ],
)
def test_c_uint_wraps_past_31_bits_and_refuses_a_minus(text, expected):
    assert ref_fields.c_uint(text) == expected


@pytest.mark.parametrize(
    "name,expected",
    [
        ("refs/heads/main", "heads/main"),
        ("refs/tags/main", "tags/main"),
        ("refs/remotes/origin/HEAD", "origin"),
        ("refs/remotes/origin/main", "origin/main"),
        ("refs/notes/commits", "notes/commits"),
        ("refs/heads/HEAD", "heads/HEAD"),
        ("HEAD", "HEAD"),
    ],
)
def test_a_ref_shortens_to_what_still_names_it(name, expected):
    known = frozenset({"HEAD", "refs/heads/main", "refs/tags/main"})
    assert ref_fields.shorten_ref(name, known) == expected


def test_a_loose_shortening_checks_only_earlier_rules():
    known = frozenset({"refs/heads/main", "refs/tags/main"})
    assert (
        ref_fields.shorten_ref("refs/tags/main", known, strict=False) == "main"
    )
    assert (
        ref_fields.shorten_ref("refs/heads/main", known, strict=False)
        == "heads/main"
    )


@pytest.mark.parametrize(
    "count,left,right",
    [
        (0, "refs/heads/feat/x", "refs/heads/feat/x"),
        (1, "heads/feat/x", "refs/heads/feat"),
        (4, "", ""),
        (-1, "x", "refs"),
        (-3, "heads/feat/x", "refs/heads/feat"),
        (-9, "refs/heads/feat/x", "refs/heads/feat/x"),
    ],
)
def test_strip_counts_components_from_either_end(count, left, right):
    assert ref_fields.lstrip_ref("refs/heads/feat/x", count) == left
    assert ref_fields.rstrip_ref("refs/heads/feat/x", count) == right


@pytest.mark.parametrize(
    "message,subject,body,signature",
    [
        ("\n\nlead\n\nbody\n", "lead", "body\n", ""),
        ("a\n \nb\n\nc\n", "a   b", "c\n", ""),
        (
            "subj\r\nwith crlf\r\n\r\nbody\r\n",
            "subj with crlf",
            "body\r\n",
            "",
        ),
        (
            "s\nmore\n-----BEGIN PGP SIGNATURE-----\nx\n",
            "s more",
            "",
            "-----BEGIN PGP SIGNATURE-----\nx\n",
        ),
        (
            "s\n\n-----BEGIN PGP SIGNATURE-----\nfirst\n"
            "-----BEGIN SSH SIGNATURE-----\nsecond\n",
            "s",
            "-----BEGIN PGP SIGNATURE-----\nfirst\n",
            "-----BEGIN SSH SIGNATURE-----\nsecond\n",
        ),
        (
            "s\n\nbody\n -----BEGIN PGP SIGNATURE-----\n",
            "s",
            "body\n -----BEGIN PGP SIGNATURE-----\n",
            "",
        ),
    ],
)
def test_message_parts_split_subject_body_and_last_signature(
    message, subject, body, signature
):
    start, found, body_at, sig = ref_fields.message_parts(message)
    assert (found, message[body_at:sig], message[sig:]) == (
        subject,
        body,
        signature,
    )


@pytest.mark.parametrize(
    "subject,expected",
    [
        (
            "Fix: the 'quoted' \"thing\" -- now (really) [done]!",
            "Fix-the-quoted-thing-now-really-done",
        ),
        ("../..//weird...name...", ".-.-weird.name"),
        ("-dashes- -in- -places-", "dashes-in-places"),
        ("unicode Ærø 日本 ü", "unicode-r"),
        ("a . .", "a"),
        ("._.", "._"),
        ("x.lock", "x.lock"),
        ("a. .b", "a.-.b"),
    ],
)
def test_sanitize_keeps_title_characters(subject, expected):
    assert ref_fields.sanitize_subject(subject) == expected


@pytest.mark.parametrize(
    "name,expected",
    [
        ("subject", "Subject line wraps"),
        ("subject:sanitize", "Subject-line-wraps"),
        ("body", "Body one.\nBody two.\n"),
        ("body:", ""),
        ("contents:lines=2", "Subject line\n    wraps"),
        ("contents:size", "40"),
        ("author", "A U Thor <author@example.com> 1584244800 +0530"),
        ("author:mailmap", ""),
        ("creator:x", "C O Mitter <committer@example.com> 1584381600 -0800"),
        ("authorname", "A U Thor"),
        ("authoremail:trim", "author@example.com"),
        ("authoremail:localpart", "author"),
        ("authordate", "Sun Mar 15 09:30:00 2020 +0530"),
        ("authordate:short", "2020-03-15"),
        ("tree:short", "ttttttt"),
        ("parent:short=4", "pppp"),
        ("numparent", "1"),
        ("tagger", ""),
        ("*objectname", ""),
        ("*refname", "refs/heads/main^{}"),
        ("*symref", "^{}"),
        ("*HEAD", "*"),
        ("refname:short", "heads/main"),
    ],
)
def test_a_commit_field(name, expected):
    assert _value(name) == expected


@pytest.mark.parametrize(
    "name,expected",
    [
        ("tag", "v1"),
        ("type", "commit"),
        ("object", "c" * 40),
        ("taggername", "T Agger"),
        ("creatordate:iso", "2020-09-13 12:26:40 +0000"),
        (
            "body",
            "More.\n-----BEGIN PGP SIGNATURE-----\nsig\n-----END PGP SIGNATURE-----\n",
        ),
        ("contents:body", "More.\n"),
        (
            "contents:signature",
            "-----BEGIN PGP SIGNATURE-----\nsig\n-----END PGP SIGNATURE-----\n",
        ),
        ("contents:lines=9", "Release notes\n    \n    More."),
        ("authorname", ""),
        ("*objectname", "c" * 40),
        ("*subject", "Subject line wraps"),
    ],
)
def test_a_tag_field_and_what_it_peels_to(name, expected):
    assert _value(name, TAG, "refs/tags/v1", peeled=COMMIT) == expected


@pytest.mark.parametrize(
    "ident,name,email,date",
    [
        (" Spaced  Name  <s@x> 1 +0100", " Spaced  Name ", "<s@x>", "1 +0100"),
        ("Name<n@x>1 +0000", "", "<n@x>", ""),
        ("<only@x> 1 +0000", "", "<only@x>", "1 +0000"),
        ("Name <n@x>", "Name", "<n@x>", ""),
    ],
)
def test_an_identity_splits_as_git_reads_it(ident, name, email, date):
    tag = RefObject(
        oid="d" * 40,
        type="tag",
        raw=f"object {'c' * 40}\ntype commit\ntag t\ntagger {ident}\n\nm\n".encode(),
    )
    shown = [
        _value(f, tag, "refs/tags/t")
        for f in ("taggername", "taggeremail", "taggerdate:raw")
    ]
    assert shown == [name, email, date]


def test_a_date_style_is_checked_wherever_the_person_line_is():
    assert _value("authordate:bogus", BLOB) == ""
    assert _value("authordate:bogus", TAG, "refs/tags/v1") == ""
    with pytest.raises(UnknownDateFormatError):
        _value("authordate:bogus")
    undated = RefObject(
        oid="d" * 40,
        type="tag",
        raw=b"object x\ntype commit\ntag t\ntagger N <n@x>\n\nm\n",
    )
    with pytest.raises(UnknownDateFormatError):
        _value("taggerdate:bogus", undated, "refs/tags/t")


def test_the_mailmap_options_map_the_ident():
    ctx = replace(
        CTX,
        mailmap=(
            MailmapEntry(
                email="author@example.com",
                name=None,
                mapped_name="Alice",
                mapped_email=None,
            ),
        ),
    )
    assert _value("authorname:mailmap", ctx=ctx) == "Alice"
    assert _value("authorname", ctx=ctx) == "A U Thor"
    assert _value("authoremail:mailmap,trim", ctx=ctx) == "author@example.com"


@pytest.mark.parametrize(
    "name,expected",
    [
        ("upstream", "refs/remotes/origin/main"),
        ("upstream:short", "origin/main"),
        ("upstream:lstrip=-1", "main"),
        ("upstream:track", "[ahead 1, behind 2]"),
        ("upstream:track,nobracket", "ahead 1, behind 2"),
        ("upstream:nobracket", "refs/remotes/origin/main"),
        ("upstream:trackshort", "<>"),
        ("upstream:remotename,remoteref", "refs/heads/main"),
        ("*upstream", "refs/remotes/origin/main"),
    ],
)
def test_an_upstream_field(name, expected):
    up = RefUpstream(
        ref="refs/remotes/origin/main",
        remote="origin",
        merge="refs/heads/main",
        ahead=1,
        behind=2,
    )
    assert _value(name, upstream=up) == expected
    assert _value(name, ref="refs/tags/main", upstream=up) == ""


def test_a_gone_upstream_tracks_as_gone():
    up = RefUpstream(
        ref="refs/remotes/origin/x",
        remote="origin",
        merge="refs/heads/x",
        gone=True,
    )
    assert _value("upstream:track", upstream=up) == "[gone]"
    assert _value("upstream:trackshort", upstream=up) == ""


def test_id_fields_widen_collisions_but_keep_longer_requested_widths():
    item = RefItem(
        name="refs/tags/v1",
        oid=TAG.oid,
        kind=RefKind.TAG,
        obj=TAG,
        peeled=COMMIT,
    )
    ctx = replace(CTX, abbreviations={COMMIT.oid: 8})
    for suffix, width in [
        ("", 40),
        (":short", 8),
        (":short=4", 8),
        (":short=12", 12),
        (":short=2147483648", 8),
    ]:
        field = ref_fields.parse_field("*objectname" + suffix)
        assert (
            ref_fields.field_value(field, item, ctx).text == COMMIT.oid[:width]
        )


def test_abbreviation_requests_take_each_id_at_its_narrowest_width():
    item = RefItem(
        name="refs/tags/v1",
        oid=TAG.oid,
        kind=RefKind.TAG,
        obj=TAG,
        peeled=COMMIT,
    )
    fields = [
        ref_fields.parse_field(name)
        for name in (
            "objectname",
            "*objectname:short=12",
            "*objectname:short=3",
            "*parent:short",
            "*tree:short=40",
        )
    ]
    assert ref_fields.abbreviation_requests(fields, [item, item], CTX) == {
        COMMIT.oid: 4,
        "p" * 40: 7,
        "t" * 40: 40,
    }


def test_a_detached_head_row_names_itself_by_its_description():
    head = RefItem(
        name="HEAD", oid=COMMIT.oid, kind=RefKind.DETACHED, obj=COMMIT
    )
    ctx = replace(
        CTX, head="HEAD", head_description="(HEAD detached at ccccccc)"
    )
    for name in ("refname", "refname:short", "refname:lstrip=1"):
        assert (
            ref_fields.field_value(
                ref_fields.parse_field(name), head, ctx
            ).text
            == "(HEAD detached at ccccccc)"
        )
    assert (
        ref_fields.field_value(ref_fields.parse_field("HEAD"), head, ctx).text
        == "*"
    )
