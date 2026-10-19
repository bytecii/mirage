import pytest

from mirage.commands.builtin.sed_script import (
    AddressKind,
    SedError,
    SedScriptPiece,
    compile_script,
)


def _expr(*texts: str) -> list[SedScriptPiece]:
    return [SedScriptPiece("expr", text) for text in texts]


@pytest.mark.parametrize(
    "script,message",
    [
        ("k", "char 1: unknown command: `k'"),
        ("2 k", "char 3: unknown command: `k'"),
        ("2 ", "char 2: missing command"),
        ("1,p", "char 3: unexpected `,'"),
        ("2!!d", "char 3: multiple `!'s"),
        ("2! !d", "char 4: multiple `!'s"),
        ("0p", "char 2: invalid usage of line address 0"),
        ("0!p", "char 2: invalid usage of line address 0"),
        ("0,5p", "char 4: invalid usage of line address 0"),
        ("1,2q", "char 4: command only uses one address"),
        ("1:a", "char 2: : doesn't want any addresses"),
        ("}", "char 1: unexpected `}'"),
        ("{p;1}", "char 5: `}' doesn't want any addresses"),
        ("{p", "char 0: unmatched `{'"),
        ("s/a/b", "char 5: unterminated `s' command"),
        ("s/a/b/k", "char 7: unknown option to `s'"),
        ("s/a/b/gg", "char 8: multiple `g' options to `s' command"),
        ("s/a/b/2g3", "char 9: multiple number options to `s' command"),
        ("s/o/O/0", "char 7: number option to `s' command may not be zero"),
        ("s/a/b/w", "char 7: missing filename in r/R/w/W commands"),
        ("s/\\(/x/;p", "char 8: Unmatched ( or \\("),
        ("/\\(/Ip", "char 5: Unmatched ( or \\("),
        ("s/x/\\9/", "char 7: invalid reference \\9 on `s' command's RHS"),
        ("y/abc/xy/", "char 9: strings for `y' command are different lengths"),
        ("y/a/b/g", "char 7: extra characters after command"),
        ("l 3x", "char 4: extra characters after command"),
        (":", 'char 1: ":" lacks a label'),
        ("a", "char 1: expected \\ after `a', `c' or `i'"),
        ("\\%a", "char 3: unterminated address regex"),
        ("//Ip", "char 3: cannot specify modifiers on empty regexp"),
        ("v 9.0", "char 5: expected newer version of sed"),
        ("e ls", "char 1: `e' command not supported"),
        ("s/\\c\\d/X/", "char 9: recursive escaping after \\c not allowed"),
        ("s/a/\\c\\d/", "char 9: recursive escaping after \\c not allowed"),
        ("y/a\\c\\d/XY/", "char 8: recursive escaping after \\c not allowed"),
        (
            "a foo\\c\\dbar",
            "char 12: recursive escaping after \\c not allowed",
        ),
        ("s/\\c/X/", "char 7: Trailing backslash"),
        ("s/a/b/\r", "char 7: unknown option to `s'"),
    ],
)
def test_refusals_carry_gnus_wording_and_place(script, message):
    with pytest.raises(SedError) as refused:
        compile_script(_expr(script), False)
    assert str(refused.value) == f"sed: -e expression #1, {message}"
    assert refused.value.exit_code == 1


def test_y_reads_its_strings_before_their_escapes():
    program = compile_script(_expr("y1a1\\x41"), False)
    assert program.commands[0].translit == {"a": "\x04"}
    with pytest.raises(SedError) as refused:
        compile_script(_expr("y1a1\\x411"), False)
    assert str(refused.value).endswith(
        "char 9: extra characters after command"
    )


@pytest.mark.parametrize(
    "pieces,message",
    [
        (("s/a/b\\", "c/"), "char 6: unterminated `s' command"),
        (("s/a\\", "b/x/"), "char 4: unterminated `s' command"),
        (("/a\\", "/p"), "char 3: unterminated address regex"),
        (("y/a\\", "/b/"), "char 4: unterminated `y' command"),
    ],
)
def test_a_command_never_continues_into_the_next_piece(pieces, message):
    with pytest.raises(SedError) as refused:
        compile_script(_expr(*pieces), False)
    assert str(refused.value) == f"sed: -e expression #1, {message}"


def test_text_continues_into_the_next_piece():
    program = compile_script(_expr("a foo\\", "bar"), False)
    assert program.commands[0].text == "foo\nbar\n"


def test_a_control_escape_that_ends_a_text():
    texts = [
        compile_script(_expr(script), False).commands[0].text
        for script in ("a foo\\c", "i foo\\c", "c foo\\c")
    ]
    assert texts == ["fooJ", "foo\n", "foo\n"]


def test_a_piece_and_a_file_are_named_as_gnu_names_them():
    with pytest.raises(SedError) as refused:
        compile_script(_expr("p", "2 k"), False)
    assert str(refused.value).startswith("sed: -e expression #2, char 3:")
    with pytest.raises(SedError) as refused:
        compile_script(_expr("2", "p"), False)
    assert str(refused.value) == (
        "sed: -e expression #1, char 1: missing command"
    )
    pieces = [
        SedScriptPiece("expr", "p"),
        SedScriptPiece("file", "p\n\n 2 k\n", "/s.sed"),
    ]
    with pytest.raises(SedError) as refused:
        compile_script(pieces, False)
    assert str(refused.value) == (
        "sed: file /s.sed line 3: unknown command: `k'"
    )


def test_a_missing_label_and_a_colon_class_exit_four():
    with pytest.raises(SedError) as refused:
        compile_script(_expr("bfoo"), False)
    assert refused.value.exit_code == 4
    assert str(refused.value) == "sed: can't find label for jump to `foo'"
    with pytest.raises(SedError) as refused:
        compile_script(_expr("s/[:alpha:]/x/"), False)
    assert refused.value.exit_code == 4
    assert str(refused.value) == (
        "sed: character class syntax is [[:space:]], not [:space:]"
    )


def test_the_w_files_opened_before_a_refusal_ride_on_it():
    with pytest.raises(SedError) as refused:
        compile_script(_expr("w /o", "k"), False)
    assert refused.value.wfiles == ["/o"]


def test_addresses():
    program = compile_script(_expr("1~0p;0~3p;2,~4p;/a/I,+2p;0,/x/p"), False)
    first = [cmd.addr1 for cmd in program.commands]
    assert first[0] is not None and first[0].kind is AddressKind.LINE
    assert first[1] is not None and first[1].kind is AddressKind.STEP
    seconds = [cmd.addr2 for cmd in program.commands[2:]]
    assert [a.kind for a in seconds if a is not None] == [
        AddressKind.MULTIPLE,
        AddressKind.PLUS,
        AddressKind.REGEX,
    ]


@pytest.mark.parametrize(
    "script,text",
    [
        ("a  one", "one\n"),
        ("a\\   two", "   two\n"),
        ("a one\\/two\\tthree", "one/two\tthree\n"),
        ("1a foo; 2d", "foo; 2d\n"),
        ("a\\\n  l1\\\n  l2", "  l1\n  l2\n"),
        ("a\\\\", "\n"),
        ("a x\\ty\\", "x\\ty\n"),
        ("a foo\\c\\\\bar", "foo\x1cbar\n"),
    ],
)
def test_text_reads_as_gnu_reads_it(script, text):
    assert compile_script(_expr(script), False).commands[0].text == text


def test_an_empty_text_appends_nothing():
    assert compile_script(_expr("a\\"), False).commands[0].text is None


def test_labels_end_at_blanks_semicolons_and_braces():
    program = compile_script(_expr("2{bx};p;:x"), False)
    assert [cmd.name for cmd in program.commands] == ["{", "b", "}", "p", ":"]
    assert program.commands[1].target == 4


def test_a_hash_after_a_label_starts_a_comment():
    program = compile_script(_expr("b done#note", ":done#here"), False)
    assert [cmd.label for cmd in program.commands] == ["done", "done"]
    assert program.commands[0].target == 1


def test_control_backslash_takes_both_backslashes():
    program = compile_script(_expr("s/\\c\\\\/\\c\\\\/;y/\\c\\\\/Z/"), False)
    subst = program.commands[0].subst
    assert subst is not None and subst.regex.regex is not None
    assert subst.regex.regex.search("a\x1cb") == [(1, 2)]
    assert [part.text for part in subst.parts] == ["\x1c"]
    assert program.commands[1].translit == {"\x1c": "Z"}


def test_a_crlf_ends_an_s_command():
    program = compile_script(_expr("s/a/b/g\r\np"), False)
    assert [cmd.name for cmd in program.commands] == ["s", "p"]


def test_a_control_escape_capitalizes_ascii_only():
    program = compile_script(_expr("s/\\c\udcdf/X/;s/\\ca/Y/"), False)
    first, second = (cmd.subst for cmd in program.commands)
    assert first is not None and first.regex.regex is not None
    assert second is not None and second.regex.regex is not None
    assert first.regex.regex.search("a\x9fb") == [(1, 2)]
    assert second.regex.regex.search("a\x01b") == [(1, 2)]


def test_filenames_stay_shell_text_in_the_c_locale():
    program = compile_script(_expr("w /data/é", "r /data/漢"), False)
    assert program.wfiles == ["/data/é"]
    assert program.commands[1].filename == "/data/漢"


def test_hash_n_first_quiets_the_script():
    assert compile_script(_expr("#n\n2p"), False).quiet
    assert not compile_script(_expr("p", "#n"), False).quiet
    assert not compile_script(_expr(" #n"), False).quiet


def test_files_are_listed_in_order():
    program = compile_script(
        _expr("w /a", "s/x/y/w /b", "r /c", "R /d", "W /a"), False
    )
    assert program.wfiles == ["/a", "/b"]
    assert program.rfiles == ["/c"]
    assert program.reader_files == ["/d"]
