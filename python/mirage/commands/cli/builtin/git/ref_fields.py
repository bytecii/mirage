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

import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import replace

from mirage.commands.cli.builtin.git.dates import parse_date_mode, show_date
from mirage.commands.cli.builtin.git.errors import (
    GitError,
    UnsupportedFieldError,
)
from mirage.commands.cli.builtin.git.format import FULL_SHA
from mirage.commands.cli.builtin.git.mailmap import mapped_identity
from mirage.commands.cli.builtin.git.types import (
    FieldValue,
    RefContext,
    RefField,
    RefItem,
    RefKind,
    RefObject,
)
from mirage.shell.bytes import decode_text

# The fewest hex digits an abbreviated id keeps, whatever width is asked.
MINIMUM_ABBREV = 4
INT_LIMIT = 1 << 31
UINT_LIMIT = 1 << 32
# The prefixes and suffixes a short ref name is read under, in the order
# gitrevisions(7) lists them: the git directory, then refs/, tags,
# branches, remote-tracking branches and a remote's HEAD.
SHORT_NAME_RULES = (
    ("", ""),
    ("refs/", ""),
    ("refs/tags/", ""),
    ("refs/heads/", ""),
    ("refs/remotes/", ""),
    ("refs/remotes/", "/HEAD"),
)
# The lines a signature in a commit or tag message opens with.
SIGNATURE_MARKERS = (
    "-----BEGIN PGP SIGNATURE-----",
    "-----BEGIN PGP MESSAGE-----",
    "-----BEGIN SSH SIGNATURE-----",
    "-----BEGIN SIGNED MESSAGE-----",
)
PEELED_SUFFIX = "^{}"
# git's fields this build refuses rather than renders: what a ref's
# storage says (deltabase, objectsize:disk, flag), a walk or a signature
# check (describe, ahead-behind, is-base, signature), push configuration,
# trailer parsing and colour.
UNSUPPORTED = frozenset(
    {
        "ahead-behind",
        "color",
        "deltabase",
        "describe",
        "flag",
        "is-base",
        "push",
        "signature",
        "trailers",
    }
)
IDENT_ROLES = ("author", "committer", "tagger")
NAME_FIELDS = ("refname", "symref")
ID_FIELDS = ("objectname", "tree", "parent")
ALIGN_POSITIONS = ("left", "middle", "right")
TRACK_WORDS = ("track", "trackshort", "remotename", "remoteref")
EMAIL_WORDS = ("trim", "localpart", "mailmap")
PERSON_ROLES = (*IDENT_ROLES, "creator")
# The fields a ref's name, upstream or worktree answers without its object.
OBJECTLESS = frozenset(
    {
        "refname",
        "symref",
        "upstream",
        "worktreepath",
        "HEAD",
        "objectname",
        "align",
        "if",
        "then",
        "else",
        "end",
    }
)


def c_int(text: str) -> int | None:
    """A decimal integer as a C ``int`` reads it: leading white space
    and a sign allowed, nothing after the digits, nothing past 32 bits.

    Args:
        text (str): the digits as typed.
    """
    found = re.fullmatch(r"[ \t\n\v\f\r]*([+-]?[0-9]+)", text)
    if found is None:
        return None
    value = int(found.group(1))
    return value if -INT_LIMIT <= value < INT_LIMIT else None


def c_uint(text: str) -> int | None:
    """A count as a C ``unsigned`` reads it, a minus refused: past 31
    bits it comes back negative, as the ``int`` it is stored in reads.

    Args:
        text (str): the digits as typed.
    """
    found = re.fullmatch(r"[ \t\n\v\f\r]*\+?([0-9]+)", text)
    if found is None:
        return None
    value = int(found.group(1))
    if value >= UINT_LIMIT:
        return None
    return value - UINT_LIMIT if value >= INT_LIMIT else value


def _label(field: RefField) -> str:
    """How an argument refusal names its field: with the ``*`` for a name,
    an id or a person field, without it for the rest.

    Args:
        field (RefField): the field.
    """
    starred = field.name in (
        "refname",
        "symref",
        "upstream",
        "push",
        *ID_FIELDS,
    ) or field.name.endswith(("name", "email"))
    return f"*{field.name}" if field.deref and starred else field.name


def _unrecognized(field: RefField, argument: str) -> GitError:
    return GitError(f"unrecognized %({_label(field)}) argument: {argument}")


def _arguments_refused(field: RefField) -> None:
    if field.argument:
        raise GitError(f"%({field.name}) does not take arguments")


def _name_variant(field: RefField, argument: str) -> RefField:
    """``short``, ``lstrip=<n>`` (``strip=<n>``) or ``rstrip=<n>``.

    Args:
        field (RefField): the field so far.
        argument (str): the argument to read.
    """
    if argument == "short":
        return replace(field, variant="short")
    for prefix, variant in (
        ("lstrip=", "lstrip"),
        ("strip=", "lstrip"),
        ("rstrip=", "rstrip"),
    ):
        if argument.startswith(prefix):
            value = argument[len(prefix) :]
            count = c_int(value)
            if count is None:
                raise GitError(
                    f"Integer value expected refname:{variant}={value}"
                )
            return replace(field, variant=variant, count=count)
    raise _unrecognized(field, argument)


def _parse_name(field: RefField) -> RefField:
    if not field.argument:
        return field
    return _name_variant(field, field.argument)


def _parse_upstream(field: RefField) -> RefField:
    """Each of ``track``, ``trackshort``, ``remotename`` and
    ``remoteref`` replaces the one before it and ``nobracket`` is a
    switch; any other word makes the whole argument one name variant.

    Args:
        field (RefField): the field so far.
    """
    argument = field.argument
    if not argument:
        return field
    variant, options = "", set()
    for word in argument.split(","):
        if word in TRACK_WORDS:
            variant = word
        elif word == "nobracket":
            options.add(word)
        else:
            return _name_variant(field, argument)
    return replace(field, variant=variant, options=frozenset(options))


def _parse_id(field: RefField) -> RefField:
    argument = field.argument
    if not argument:
        return field
    if argument == "short":
        return replace(field, variant="short", count=0)
    if argument.startswith("short="):
        value = argument[len("short=") :]
        width = c_uint(value)
        if width is None or width == 0:
            raise GitError(
                f"positive value expected '{value}' in %({field.text})"
            )
        # A width past 31 bits wraps negative and reads as plain short.
        return replace(field, variant="short", count=max(width, 0))
    raise _unrecognized(field, argument)


def _parse_objectsize(field: RefField) -> RefField:
    if not field.argument:
        return field
    if field.argument == "disk":
        raise UnsupportedFieldError(field.text)
    raise GitError(f"unrecognized %(objectsize) argument: {field.argument}")


def _parse_raw(field: RefField) -> RefField:
    if not field.argument:
        return field
    if field.argument == "size":
        return replace(field, variant="size")
    raise GitError(f"unrecognized %(raw) argument: {field.argument}")


def _parse_rest(field: RefField) -> RefField:
    _arguments_refused(field)
    raise GitError(f"this command reject atom %({field.text})")


def _parse_bare(field: RefField) -> RefField:
    _arguments_refused(field)
    return field


def _parse_body(field: RefField) -> RefField:
    """``body`` refuses an argument, and prints nothing at all after an
    empty one.

    Args:
        field (RefField): the field so far.
    """
    _arguments_refused(field)
    return field if field.argument is None else replace(field, variant="blank")


def _parse_ignoring(field: RefField) -> RefField:
    return replace(field, argument=None)


def _parse_person(field: RefField) -> RefField:
    """``author``, ``committer`` and ``tagger`` print nothing at all once
    they have a colon, whatever follows it.

    Args:
        field (RefField): the field so far.
    """
    return (
        replace(field, variant="blank")
        if field.argument is not None
        else field
    )


def _parse_person_name(field: RefField) -> RefField:
    if not field.argument:
        return field
    if field.argument == "mailmap":
        return replace(field, options=frozenset({"mailmap"}))
    raise _unrecognized(field, field.argument)


def _parse_email(field: RefField) -> RefField:
    """A comma list of ``trim``, ``localpart`` and ``mailmap``, each word
    read off the front of what is left; the refusal names that rest.

    Args:
        field (RefField): the field so far.
    """
    rest = field.argument
    if not rest:
        return field
    options: set[str] = set()
    while True:
        word = next((w for w in EMAIL_WORDS if rest.startswith(w)), None)
        if word is None:
            raise _unrecognized(field, rest)
        options.add(word)
        rest = rest[len(word) :]
        if not rest:
            break
        if not rest.startswith(","):
            raise _unrecognized(field, rest)
        rest = rest[1:]
    return replace(field, options=frozenset(options))


def _parse_date(field: RefField) -> RefField:
    # The style is checked where a date is shown, so a listing whose refs
    # carry no such date never refuses it.
    return replace(field, date=field.argument)


def _parse_subject(field: RefField) -> RefField:
    if not field.argument:
        return field
    if field.argument == "sanitize":
        return replace(field, variant="sanitize")
    raise GitError(f"unrecognized %(subject) argument: {field.argument}")


def _parse_contents(field: RefField) -> RefField:
    argument = field.argument
    if not argument:
        return field
    if argument in ("subject", "body", "signature", "size"):
        return replace(field, variant=argument)
    if argument == "trailers" or argument.startswith("trailers:"):
        raise UnsupportedFieldError(field.text)
    if argument.startswith("lines="):
        count = c_uint(argument[len("lines=") :])
        if count is None:
            raise GitError(f"positive value expected contents:{argument}")
        return replace(field, variant="lines", count=max(count, 0))
    raise GitError(f"unrecognized %(contents) argument: {argument}")


def _align_width(text: str) -> int | None:
    value = c_uint(text)
    return None if value is None or value < 0 else value


def _parse_align(field: RefField) -> RefField:
    """``<width>`` and ``<position>`` in either order, by name or bare,
    the last of each winning.

    Args:
        field (RefField): the field so far.
    """
    if not field.argument:
        raise GitError("expected format: %(align:<width>,<position>)")
    width: int | None = None
    position = "left"
    for word in field.argument.split(","):
        if word.startswith("position="):
            value = word[len("position=") :]
            if value not in ALIGN_POSITIONS:
                raise GitError(f"unrecognized position:{value}")
            position = value
        elif word.startswith("width="):
            value = word[len("width=") :]
            width = _align_width(value)
            if width is None:
                raise GitError(f"unrecognized width:{value}")
        elif word in ALIGN_POSITIONS:
            position = word
        else:
            found = _align_width(word)
            if found is None:
                raise GitError(f"unrecognized %(align) argument: {word}")
            width = found
    if width is None:
        raise GitError("positive width expected with the %(align) atom")
    return replace(field, variant=position, count=width)


def _parse_if(field: RefField) -> RefField:
    argument = field.argument
    if not argument:
        return replace(field, argument=None)
    for word in ("equals", "notequals"):
        if argument.startswith(f"{word}="):
            return replace(field, variant=word)
    raise GitError(f"unrecognized %(if) argument: {argument}")


def _parse_unsupported(field: RefField) -> RefField:
    """A field this build does not render, refused as unsupported once
    git would accept its argument; an argument git refuses is refused in
    git's words first.

    Args:
        field (RefField): the field so far.
    """
    name = field.name
    if name == "deltabase":
        _arguments_refused(field)
    elif name in ("is-base", "ahead-behind"):
        if not field.argument:
            raise GitError(f"expected format: %({name}:<committish>)")
    elif name == "color":
        if not field.argument:
            raise GitError("expected format: %(color:<color>)")
    elif name == "push":
        _parse_upstream(field)
    raise UnsupportedFieldError(field.text)


PARSERS: dict[str, Callable[[RefField], RefField]] = {
    "refname": _parse_name,
    "symref": _parse_name,
    "upstream": _parse_upstream,
    "worktreepath": _parse_ignoring,
    "HEAD": _parse_bare,
    "objecttype": _parse_bare,
    "objectsize": _parse_objectsize,
    "objectname": _parse_id,
    "tree": _parse_id,
    "parent": _parse_id,
    "numparent": _parse_ignoring,
    "object": _parse_ignoring,
    "type": _parse_ignoring,
    "tag": _parse_ignoring,
    "raw": _parse_raw,
    "rest": _parse_rest,
    "creator": _parse_ignoring,
    "creatordate": _parse_date,
    "subject": _parse_subject,
    "body": _parse_body,
    "contents": _parse_contents,
    "align": _parse_align,
    "if": _parse_if,
    "then": _parse_ignoring,
    "else": _parse_ignoring,
    "end": _parse_ignoring,
    **{name: _parse_unsupported for name in UNSUPPORTED},
}
for _role in IDENT_ROLES:
    PARSERS[_role] = _parse_person
    PARSERS[f"{_role}name"] = _parse_person_name
    PARSERS[f"{_role}email"] = _parse_email
    PARSERS[f"{_role}date"] = _parse_date


def parse_field(text: str) -> RefField:
    """Read one field as a format's ``%(...)`` or a sort key spells it.

    Args:
        text (str): the field, ``*`` and argument included.

    Raises:
        GitError: a name git does not have, or an argument it refuses.
        UnsupportedFieldError: a field git has that this build does not
            render.
    """
    deref = text.startswith("*")
    body = text[1:] if deref else text
    name, colon, argument = body.partition(":")
    if not name and not colon:
        raise GitError(f"malformed field name: {text}")
    parser = PARSERS.get(name)
    if parser is None:
        raise GitError(f"unknown field name: {text}")
    return parser(
        RefField(
            text=text,
            name=name,
            deref=deref,
            argument=argument if colon else None,
        )
    )


def needs_object(field: RefField) -> bool:
    """Whether a field reads the ref's object, not only its name.

    Args:
        field (RefField): the parsed field.
    """
    return field.name not in OBJECTLESS or (
        field.deref and field.name == "objectname"
    )


def shorten_ref(name: str, known: Iterable[str], strict: bool = True) -> str:
    """The shortest name that still reads back as ``name``.

    Each way of spelling a short name, most specific first, gives a
    candidate; one is taken when no other way (``strict``), or no way
    rev-parse tries before it (loose), turns it into another ref that
    exists.

    Args:
        name (str): the full ref name.
        known (Iterable[str]): every name that resolves.
        strict (bool): ``core.warnAmbiguousRefs``.
    """
    names = known if isinstance(known, (set, frozenset)) else set(known)
    for at in range(len(SHORT_NAME_RULES) - 1, 0, -1):
        prefix, suffix = SHORT_NAME_RULES[at]
        if not name.startswith(prefix) or not name.endswith(suffix):
            continue
        short = name[len(prefix) : len(name) - len(suffix)]
        if not short:
            continue
        rivals = SHORT_NAME_RULES if strict else SHORT_NAME_RULES[:at]
        if not any(
            f"{p}{short}{s}" in names
            for i, (p, s) in enumerate(rivals)
            if i != at and f"{p}{short}{s}" != name
        ):
            return short
    return name


def lstrip_ref(name: str, count: int) -> str:
    """``name`` less ``count`` components from the front; a negative
    count keeps that many from the back instead.

    Args:
        name (str): the ref name.
        count (int): the components to strip, or to keep when negative.
    """
    parts = name.split("/")
    if count < 0:
        return "/".join(parts[max(len(parts) + count, 0) :])
    return "/".join(parts[count:]) if count < len(parts) else ""


def rstrip_ref(name: str, count: int) -> str:
    """``name`` less ``count`` components from the back; a negative
    count keeps that many from the front instead.

    Args:
        name (str): the ref name.
        count (int): the components to strip, or to keep when negative.
    """
    parts = name.split("/")
    if count < 0:
        return (
            "/".join(parts[: max(-count, 0)]) if -count < len(parts) else name
        )
    return "/".join(parts[: len(parts) - count]) if count < len(parts) else ""


def _name_text(field: RefField, name: str, ctx: RefContext) -> str:
    if field.variant == "short":
        return shorten_ref(name, ctx.known, ctx.strict)
    if field.variant == "lstrip":
        return lstrip_ref(name, field.count)
    if field.variant == "rstrip":
        return rstrip_ref(name, field.count)
    return name


def ident_date(ident: str) -> tuple[int, int] | None:
    """The instant and offset an identity line records.

    The date follows the email's ``>`` and a space: seconds, then an
    optional ``+hhmm`` offset.

    Args:
        ident (str): ``Name <email> <seconds> <+hhmm>``.

    Returns:
        tuple[int, int] | None: the seconds since the epoch and the
        offset in seconds east of UTC, None when the line has no date
        after its email.
    """
    close = ident.rfind(">")
    if close == -1:
        return None
    found = re.match(
        r" +([0-9]+)(?: +([+-])([0-9]{2})([0-9]{2}))?", ident[close + 1 :]
    )
    if found is None:
        return None
    seconds = int(found.group(1))
    if found.group(2) is None:
        return seconds, 0
    hours, minutes = int(found.group(3)), int(found.group(4))
    offset = hours * 3600 + minutes * 60
    return seconds, -offset if found.group(2) == "-" else offset


def _headers(obj: RefObject) -> tuple[list[tuple[str, str]], str]:
    """An object's header lines and its message.

    Args:
        obj (RefObject): a commit or tag.
    """
    text = decode_text(obj.raw)
    head, gap, message = text.partition("\n\n")
    if not gap and text.endswith("\n"):
        head = text[:-1]
    headers = []
    for line in head.split("\n"):
        key, _, value = line.partition(" ")
        if line and not line.startswith(" "):
            headers.append((key, value))
    return headers, message


def _header(obj: RefObject, key: str) -> str | None:
    return next((v for k, v in _headers(obj)[0] if k == key), None)


def _signature_at(message: str) -> int:
    """Where the last signature line starts, the message's length when
    no line opens one.

    Args:
        message (str): the message.
    """
    at = len(message)
    start = 0
    while start < len(message):
        end = message.find("\n", start)
        end = len(message) if end == -1 else end + 1
        if message.startswith(SIGNATURE_MARKERS, start):
            at = start
        start = end
    return at


def _blank(line: str) -> bool:
    return line in ("", "\r")


def _line_end(message: str, at: int, sig: int) -> int:
    """Where the line at ``at`` ends before the signature, -1 if it runs
    into it."""
    return message.find("\n", at, sig)


def message_parts(message: str) -> tuple[int, str, int, int]:
    """Split a message as the message fields read it.

    The subject is the first paragraph after any empty lines, its lines
    joined with spaces (a carriage return before each newline dropped);
    the body starts at the next line that is not empty. A signature cuts
    both short where its line starts.

    Args:
        message (str): the message.

    Returns:
        tuple[int, str, int, int]: where the subject starts, the subject,
        where the body starts and where the signature starts.
    """
    sig = _signature_at(message)
    at = 0
    while at < sig:
        end = _line_end(message, at, sig)
        if end == -1 or not _blank(message[at:end]):
            break
        at = end + 1
    start = at
    lines = []
    while at < sig:
        end = _line_end(message, at, sig)
        line = message[at : sig if end == -1 else end]
        if _blank(line):
            break
        lines.append(line.removesuffix("\r"))
        at = sig if end == -1 else end + 1
    while at < sig:
        end = _line_end(message, at, sig)
        if end == -1 or not _blank(message[at:end]):
            break
        at = end + 1
    return start, " ".join(lines), at, sig


def _title_char(ch: str) -> bool:
    """Whether a subject character stays in its file name."""
    return ch.isascii() and (ch.isalnum() or ch in "._")


def sanitize_subject(subject: str) -> str:
    """A subject as a file name: letters, digits, ``.`` and ``_`` kept,
    each run of anything else one ``-`` between them, a run of dots one
    dot, and trailing dots and dashes dropped.

    Args:
        subject (str): the subject.
    """
    out: list[str] = []
    gap = False
    for ch in subject:
        if _title_char(ch):
            if gap and out:
                out.append("-")
            gap = False
            if ch == "." and out and out[-1] == ".":
                continue
            out.append(ch)
        else:
            gap = True
    return "".join(out).rstrip(".-")


def _message_lines(message: str, start: int, sig: int, count: int) -> str:
    """``contents:lines=<n>``: the first lines from the subject on, each
    after the first indented four spaces.

    Args:
        message (str): the message.
        start (int): where the subject starts.
        sig (int): where the signature starts.
        count (int): how many lines.
    """
    lines: list[str] = []
    at = start
    while at < sig and len(lines) < count:
        end = _line_end(message, at, sig)
        lines.append(message[at : sig if end == -1 else end])
        at = sig if end == -1 else end + 1
    return "\n    ".join(lines)


def _abbreviated(field: RefField, oid: str, ctx: RefContext) -> str:
    if field.variant != "short":
        return oid
    width = _requested_width(field, ctx)
    return oid[: max(width, ctx.abbreviations.get(oid, width))]


def _requested_width(field: RefField, ctx: RefContext) -> int:
    width = field.count or ctx.abbrev
    return min(max(width, MINIMUM_ABBREV), FULL_SHA)


def _shown_object(field: RefField, item: RefItem) -> RefObject | None:
    return item.peeled if field.deref else item.obj


def _ids(field: RefField, item: RefItem) -> list[str]:
    """The ids an id field shows for a ref.

    Args:
        field (RefField): ``objectname``, ``tree`` or ``parent``.
        item (RefItem): the ref.
    """
    if field.name == "objectname":
        if field.deref:
            return [item.peeled.oid] if item.peeled is not None else []
        return [item.oid]
    obj = _shown_object(field, item)
    if obj is None or obj.type != "commit":
        return []
    return [v for k, v in _headers(obj)[0] if k == field.name]


def abbreviation_requests(
    fields: Sequence[RefField], items: Sequence[RefItem], ctx: RefContext
) -> dict[str, int]:
    """The ids a listing abbreviates, each at the narrowest width any of
    its fields asks, for one pass that widens them to be unique.

    Args:
        fields (Sequence[RefField]): every field the listing reads.
        items (Sequence[RefItem]): the listed refs.
        ctx (RefContext): carries the default width.
    """
    widths: dict[str, int] = {}
    for field in fields:
        if field.name not in ID_FIELDS or field.variant != "short":
            continue
        width = _requested_width(field, ctx)
        for item in items:
            for oid in _ids(field, item):
                widths[oid] = min(widths.get(oid, width), width)
    return widths


def _upstream_text(field: RefField, item: RefItem, ctx: RefContext) -> str:
    up = item.upstream
    if up is None or item.kind is not RefKind.BRANCH:
        return ""
    if field.variant == "remotename":
        return up.remote
    if field.variant == "remoteref":
        return up.merge
    if field.variant == "trackshort":
        if up.gone:
            return ""
        if up.ahead and up.behind:
            return "<>"
        return ">" if up.ahead else "<" if up.behind else "="
    if field.variant == "track":
        if up.gone:
            state = "gone"
        else:
            state = ", ".join(
                f"{word} {count}"
                for word, count in (("ahead", up.ahead), ("behind", up.behind))
                if count
            )
        if not state:
            return ""
        return state if "nobracket" in field.options else f"[{state}]"
    return _name_text(field, up.ref, ctx)


def _person(obj: RefObject | None, role: str) -> str | None:
    """The identity line a person field reads, None when the object has
    none: ``creator`` is a commit's committer and a tag's tagger.

    Args:
        obj (RefObject | None): the object.
        role (str): ``author``, ``committer``, ``tagger`` or ``creator``.
    """
    if obj is None or obj.type not in ("commit", "tag"):
        return None
    if role == "creator":
        role = "committer" if obj.type == "commit" else "tagger"
    return _header(obj, role)


def _split_ident(ident: str) -> tuple[str, str]:
    """An identity's name and its email, brackets included: the name is
    what comes before the space ahead of ``<``, empty without one.

    Args:
        ident (str): ``Name <email> <date>``.
    """
    space = ident.find(" <")
    name = ident[:space] if space != -1 else ""
    lt = ident.find("<")
    if lt == -1:
        return name, ""
    gt = ident.find(">", lt)
    return name, ident[lt:] if gt == -1 else ident[lt : gt + 1]


def _mapped(ident: str, ctx: RefContext) -> tuple[str, str]:
    name, email = _split_ident(ident)
    if not ctx.mailmap:
        return name, email
    found = mapped_identity(f"{name} {email}", ctx.mailmap)
    return _split_ident(found)


def _person_value(
    field: RefField, item: RefItem, ctx: RefContext
) -> FieldValue:
    role, part = _person_role(field.name)
    ident = _person(_shown_object(field, item), role)
    if ident is None:
        return FieldValue("", 0 if part == "date" else None)
    if part == "":
        return FieldValue("" if field.variant == "blank" else ident)
    if part == "date":
        mode = (
            ctx.date
            if field.date is None
            else parse_date_mode(field.date, ctx.date)
        )
        found = ident_date(ident)
        if found is None:
            return FieldValue("", 0)
        seconds, offset = found
        return FieldValue(show_date(seconds, offset, mode), seconds)
    mapped = "mailmap" in field.options
    name, email = _mapped(ident, ctx) if mapped else _split_ident(ident)
    if part == "name":
        return FieldValue(name)
    if "trim" in field.options or "localpart" in field.options:
        email = email.removeprefix("<").removesuffix(">")
        if "localpart" in field.options:
            email = email.partition("@")[0]
    return FieldValue(email)


def _person_role(name: str) -> tuple[str, str]:
    for role in PERSON_ROLES:
        if name.startswith(role):
            return role, name[len(role) :]
    return name, ""


def _message_value(field: RefField, item: RefItem) -> FieldValue:
    obj = _shown_object(field, item)
    if obj is None or obj.type not in ("commit", "tag"):
        # A size nothing has is nothing to print, and 0 to sort by.
        return FieldValue("", 0 if field.variant == "size" else None)
    message = _headers(obj)[1]
    start, subject, body, sig = message_parts(message)
    variant = field.variant
    if field.name == "subject" or variant == "subject":
        return FieldValue(
            sanitize_subject(subject) if variant == "sanitize" else subject
        )
    if field.name == "body":
        return FieldValue("" if variant == "blank" else message[body:])
    if variant == "body":
        return FieldValue(message[body:sig])
    if variant == "signature":
        return FieldValue(message[sig:])
    # The contents start at the subject: empty lines before it are no
    # part of them.
    if variant == "size":
        size = len(message[start:].encode("utf-8", "surrogateescape"))
        return FieldValue(str(size), size)
    if variant == "lines":
        return FieldValue(_message_lines(message, start, sig, field.count))
    return FieldValue(message[start:])


def _object_value(
    field: RefField, item: RefItem, ctx: RefContext
) -> FieldValue:
    name = field.name
    if name in ID_FIELDS:
        ids = [_abbreviated(field, oid, ctx) for oid in _ids(field, item)]
        return FieldValue(" ".join(ids))
    obj = _shown_object(field, item)
    if obj is None:
        counted = (
            name in ("objectsize", "numparent") or field.variant == "size"
        )
        return FieldValue("", 0 if counted else None)
    if name == "objecttype":
        return FieldValue(obj.type)
    if name == "objectsize":
        return FieldValue(str(len(obj.raw)), len(obj.raw))
    if name == "raw":
        if field.variant == "size":
            return FieldValue(str(len(obj.raw)), len(obj.raw))
        return FieldValue(decode_text(obj.raw))
    if name == "numparent":
        if obj.type != "commit":
            return FieldValue("", 0)
        count = sum(1 for k, _ in _headers(obj)[0] if k == "parent")
        return FieldValue(str(count), count)
    if obj.type != "tag":
        return FieldValue("")
    return FieldValue(_header(obj, name) or "")


def _ref_value(field: RefField, item: RefItem, ctx: RefContext) -> FieldValue:
    name = field.name
    if name == "HEAD":
        return FieldValue("*" if item.name == ctx.head else " ")
    if name == "worktreepath":
        return FieldValue(item.worktree)
    if name == "upstream":
        return FieldValue(_upstream_text(field, item, ctx))
    if item.kind is RefKind.DETACHED and name == "refname":
        text = ctx.head_description
    elif name == "symref":
        text = _name_text(field, item.symref, ctx) if item.symref else ""
    else:
        text = _name_text(field, item.name, ctx)
    return FieldValue(f"{text}{PEELED_SUFFIX}" if field.deref else text)


REF_FIELDS = frozenset(("HEAD", "worktreepath", "upstream", *NAME_FIELDS))
MESSAGE_FIELDS = frozenset(("subject", "body", "contents"))


def field_value(field: RefField, item: RefItem, ctx: RefContext) -> FieldValue:
    """What one field prints for one ref, and what it sorts by.

    Args:
        field (RefField): the parsed field.
        item (RefItem): the ref, loaded as far as the field reads it.
        ctx (RefContext): the listing's facts.

    Raises:
        GitError: a date style git does not have, met on a date.
    """
    if field.name in REF_FIELDS:
        return _ref_value(field, item, ctx)
    if field.name in MESSAGE_FIELDS:
        return _message_value(field, item)
    if _person_role(field.name)[0] in PERSON_ROLES:
        return _person_value(field, item, ctx)
    return _object_value(field, item, ctx)


def mailmapped(fields: Iterable[RefField]) -> bool:
    """Whether a listing reads the mailmap.

    Args:
        fields (Iterable[RefField]): every field the listing reads.
    """
    return any("mailmap" in field.options for field in fields)
