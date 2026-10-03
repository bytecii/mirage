import pytest

from mirage import MountMode, RAMResource, Workspace
from mirage.io.stream import materialize
from mirage.shell.variable import VarAttr
from mirage.workspace.executor.builtins.vars import (handle_export,
                                                     handle_readonly,
                                                     handle_unset)
from mirage.workspace.session.session import Session
from mirage.workspace.session.state import seed_var, set_attr


def seed_exported(session: Session, name: str, value: str) -> None:
    """Seed a variable the process-view printers will actually list.

    `env`, `printenv` and `export -p` show exported names only, so a
    test whose subject is ordering or quoting has to mark what it seeds
    or it renders nothing at all. `seed_var` alone makes a correct
    plain shell variable, which those three rightly never print.

    Args:
        session (Session): the session being seeded.
        name (str): variable name.
        value (str): the value to store.
    """
    seed_var(session, name, value)
    set_attr(session, name, VarAttr.EXPORT)


def make_session() -> Session:
    return Session(session_id="s1")


@pytest.mark.asyncio
async def test_unset_f_removes_function_only():
    session = make_session()
    session.functions["fn"] = []
    seed_var(session, "fn", "keepvar")
    await handle_unset(["-f", "fn"], session)
    assert "fn" not in session.functions
    assert session.env["fn"] == "keepvar"


@pytest.mark.asyncio
async def test_unset_v_removes_variable_not_function():
    session = make_session()
    session.functions["fn"] = []
    seed_var(session, "fn", "v")
    await handle_unset(["-v", "fn"], session)
    assert "fn" in session.functions
    assert "fn" not in session.env


@pytest.mark.asyncio
async def test_unset_bare_prefers_variable_then_function():
    session = make_session()
    session.functions["a"] = []
    seed_var(session, "a", "v")
    await handle_unset(["a"], session)
    # The variable existed, so only it is removed.
    assert "a" not in session.env
    assert "a" in session.functions
    # No variable of this name: the function is removed instead.
    session.functions["b"] = []
    await handle_unset(["b"], session)
    assert "b" not in session.functions


@pytest.mark.asyncio
async def test_unset_removes_whole_array_and_one_element():
    session = make_session()
    seed_var(session, "arr", ["x", "y", "z"])
    # An interior element leaves a hole: the later indices keep their
    # positions, as bash does.
    await handle_unset(["arr[1]"], session)
    assert session.arrays["arr"] == ["x", None, "z"]
    # A trailing element drops off, so the extent shrinks with it.
    await handle_unset(["arr[2]"], session)
    assert session.arrays["arr"] == ["x"]
    await handle_unset(["arr"], session)
    assert "arr" not in session.arrays


@pytest.mark.asyncio
async def test_unset_readonly_array_element_is_rejected():
    session = make_session()
    seed_var(session, "arr", ["x", "y"])
    set_attr(session, "arr", VarAttr.READONLY)
    _, io, node = await handle_unset(["arr[1]"], session)
    assert node.exit_code == 1
    assert io.stderr == b"bash: unset: arr: cannot unset: readonly variable\n"
    assert session.arrays["arr"] == ["x", "y"]


@pytest.mark.asyncio
async def test_unset_element_zero_of_a_scalar_removes_it():
    session = make_session()
    seed_var(session, "Y", "sc")
    _, io, node = await handle_unset(["Y[0]"], session)
    assert node.exit_code == 0
    assert "Y" not in session.env


@pytest.mark.asyncio
async def test_unset_nonzero_element_of_a_scalar_errors():
    session = make_session()
    seed_var(session, "Y", "sc")
    _, io, node = await handle_unset(["Y[1]"], session)
    assert node.exit_code == 1
    assert io.stderr == b"bash: unset: Y: not an array variable\n"
    assert session.env["Y"] == "sc"


@pytest.mark.asyncio
async def test_unset_negative_element_outside_the_extent_errors():
    session = make_session()
    seed_var(session, "arr", ["x"])
    _, io, node = await handle_unset(["arr[-2]"], session)
    assert node.exit_code == 1
    # bash prints only the bracketed part here, not the base name.
    assert io.stderr == b"bash: unset: [-2]: bad array subscript\n"
    assert session.arrays["arr"] == ["x"]


@pytest.mark.asyncio
async def test_unset_negative_element_inside_the_extent_works():
    session = make_session()
    seed_var(session, "arr", ["x", "y"])
    _, io, node = await handle_unset(["arr[-2]"], session)
    assert node.exit_code == 0
    assert session.arrays["arr"] == [None, "y"]


@pytest.mark.asyncio
async def test_unset_element_of_an_unset_name_is_a_no_op():
    session = make_session()
    _, io, node = await handle_unset(["GONE[3]"], session)
    assert node.exit_code == 0


@pytest.mark.asyncio
async def test_unset_invalid_option_errors():
    session = make_session()
    _, io, node = await handle_unset(["-z", "x"], session)
    assert node.exit_code == 2
    assert b"invalid option" in (io.stderr or b"")


@pytest.mark.asyncio
async def test_export_p_prints_declare_x():
    session = make_session()
    seed_exported(session, "ZZZ", "1")
    seed_exported(session, "AAA", 'a"b')
    seed_exported(session, "NL", "a\nb")
    seed_exported(session, "DOL", "a$b")
    out, io, _ = await handle_export(["-p"], session)
    assert io.exit_code == 0
    text = (await materialize(out)).decode()
    assert 'declare -x AAA="a\\"b"\n' in text
    assert 'declare -x DOL="a\\$b"\n' in text
    assert "declare -x NL=$'a\\nb'\n" in text
    assert 'declare -x ZZZ="1"\n' in text
    # Sorted by name
    assert text.index("AAA") < text.index("ZZZ")


@pytest.mark.asyncio
async def test_export_bare_prints_like_p():
    session = make_session()
    seed_exported(session, "FOO", "bar")
    out, io, _ = await handle_export([], session)
    assert io.exit_code == 0
    # `$PWD` is exported like any other variable, so bash lists it too.
    assert await materialize(out) == (b'declare -x FOO="bar"\n'
                                      b'declare -x PWD="/"\n')


@pytest.mark.asyncio
async def test_export_invalid_option_exit_2():
    session = make_session()
    _, io, _ = await handle_export(["-z"], session)
    assert io.exit_code == 2
    err = (io.stderr or b"").decode()
    assert "invalid option" in err
    assert "usage: export" in err


@pytest.mark.asyncio
async def test_export_p_with_name_does_not_print():
    session = make_session()
    seed_var(session, "KEEP", "1")
    out, io, _ = await handle_export(["-p", "FOO=bar"], session)
    assert io.exit_code == 0
    assert out is None
    assert session.env["FOO"] == "bar"


@pytest.mark.asyncio
async def test_readonly_p_prints_scalars_and_arrays():
    session = make_session()
    seed_var(session, "VAL", "x")
    set_attr(session, "VAL", VarAttr.READONLY)
    set_attr(session, "ONLY", VarAttr.READONLY)
    seed_var(session, "AR", ["a", "b c"])
    set_attr(session, "AR", VarAttr.READONLY)
    out, io, _ = await handle_readonly(["-p"], session)
    assert io.exit_code == 0
    text = (await materialize(out)).decode()
    assert 'declare -ar AR=([0]="a" [1]="b c")\n' in text
    assert "declare -r ONLY\n" in text
    assert 'declare -r VAL="x"\n' in text


@pytest.mark.asyncio
async def test_readonly_invalid_option_exit_2():
    session = make_session()
    _, io, _ = await handle_readonly(["-z"], session)
    assert io.exit_code == 2
    err = (io.stderr or b"").decode()
    assert "invalid option" in err
    assert "usage: readonly" in err


@pytest.mark.asyncio
async def test_export_p_via_workspace():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute('export ZEP1=v1; export -p | grep ZEP1')
    assert io.exit_code == 0
    assert (io.stdout or b"") == b'declare -x ZEP1="v1"\n'


@pytest.mark.asyncio
async def test_readonly_p_via_workspace():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute('readonly ZRP1=7; readonly -p | grep ZRP1')
    assert io.exit_code == 0
    assert (io.stdout or b"") == b'declare -r ZRP1="7"\n'


@pytest.mark.asyncio
async def test_export_invalid_option_via_workspace():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute("export -z")
    assert io.exit_code == 2
    assert b"invalid option" in (io.stderr or b"")


@pytest.mark.asyncio
async def test_export_p_quotes_control_characters():
    session = make_session()
    session.vars.clear()
    seed_exported(session, "TAB", "a\tb")
    seed_exported(session, "ESC", "a\x1bb")
    seed_exported(session, "BEL", "a\x07b")
    seed_exported(session, "SOH", "a\x01b")
    seed_exported(session, "DEL", "a\x7fb")
    seed_exported(session, "UTF", "café")
    out, io, _ = await handle_export(["-p"], session)
    assert io.exit_code == 0
    text = (await materialize(out)).decode()
    # GNU bash uses $'...' for any control character, named escapes where
    # it has one and three-digit octal otherwise.
    assert "declare -x TAB=$'a\\tb'\n" in text
    assert "declare -x ESC=$'a\\Eb'\n" in text
    assert "declare -x BEL=$'a\\ab'\n" in text
    assert "declare -x SOH=$'a\\001b'\n" in text
    assert "declare -x DEL=$'a\\177b'\n" in text
    # Printable non-ASCII stays literal, as bash does in a UTF-8 locale.
    assert 'declare -x UTF="café"\n' in text


@pytest.mark.asyncio
async def test_export_p_double_terminator_still_prints():
    session = make_session()
    session.vars.clear()
    seed_exported(session, "FOO", "bar")
    out, io, _ = await handle_export(["-p", "--"], session)
    assert io.exit_code == 0
    assert await materialize(out) == b'declare -x FOO="bar"\n'


@pytest.mark.asyncio
async def test_export_f_lists_no_variables():
    session = make_session()
    seed_var(session, "FOO", "bar")
    out, io, _ = await handle_export(["-f"], session)
    assert io.exit_code == 0
    assert await materialize(out) == b""


@pytest.mark.asyncio
async def test_export_reports_first_invalid_option():
    session = make_session()
    _, io, _ = await handle_export(["-zq"], session)
    assert (io.stderr or b"").startswith(b"bash: export: -z: invalid option")


@pytest.mark.asyncio
async def test_readonly_a_lists_arrays_only():
    session = make_session()
    seed_var(session, "VAL", "x")
    set_attr(session, "VAL", VarAttr.READONLY)
    seed_var(session, "AR", ["a"])
    set_attr(session, "AR", VarAttr.READONLY)
    out, io, _ = await handle_readonly(["-a"], session)
    assert io.exit_code == 0
    assert await materialize(out) == b'declare -ar AR=([0]="a")\n'


@pytest.mark.asyncio
async def test_readonly_f_and_A_list_nothing():
    session = make_session()
    seed_var(session, "VAL", "x")
    set_attr(session, "VAL", VarAttr.READONLY)
    for flag in ("-f", "-A"):
        out, io, _ = await handle_readonly([flag], session)
        assert io.exit_code == 0
        assert await materialize(out) == b""


@pytest.mark.asyncio
async def test_export_p_terminator_via_workspace():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute('export ZEP5=v5; export -p -- | grep ZEP5')
    assert io.exit_code == 0
    assert (io.stdout or b"") == b'declare -x ZEP5="v5"\n'


@pytest.mark.asyncio
async def test_readonly_a_via_workspace():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute("readonly ZRS1=1; readonly -a ZRA1=(x); readonly -a")
    assert io.exit_code == 0
    assert (io.stdout or b"") == b'declare -ar ZRA1=([0]="x")\n'
