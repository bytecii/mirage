import pytest

from mirage.io.stream import materialize
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ExitSignal
from mirage.workspace.executor.builtins.flow import handle_exit, handle_return
from mirage.workspace.executor.control import ReturnSignal
from mirage.workspace.session.session import Session


def make_function_stack() -> CallStack:
    cs = CallStack()
    cs.push([], function_name="f")
    return cs


def make_session() -> Session:
    return Session(session_id="s1")


@pytest.mark.asyncio
async def test_return_non_numeric_raises_2_with_message():
    with pytest.raises(ReturnSignal) as exc:
        await handle_return(["x"], make_session(), make_function_stack())
    assert exc.value.exit_code == 2
    assert exc.value.stderr == b"return: x: numeric argument required\n"


@pytest.mark.asyncio
async def test_return_numeric():
    with pytest.raises(ReturnSignal) as exc:
        await handle_return(["7"], make_session(), make_function_stack())
    assert exc.value.exit_code == 7
    assert exc.value.stderr == b""


@pytest.mark.asyncio
async def test_return_bare_propagates_last_exit_code():
    session = make_session()
    session.last_exit_code = 1
    with pytest.raises(ReturnSignal) as exc:
        await handle_return([], session, make_function_stack())
    assert exc.value.exit_code == 1


@pytest.mark.asyncio
async def test_return_outside_function_fails_without_signal():
    _, io, _ = await handle_return([], make_session(), CallStack())
    assert io.exit_code == 2
    assert b"can only `return'" in io.stderr


@pytest.mark.asyncio
async def test_return_in_source_raises_signal():
    session = make_session()
    session.source_depth = 1
    session.last_exit_code = 0
    with pytest.raises(ReturnSignal) as exc:
        await handle_return([], session, None)
    assert exc.value.exit_code == 0


@pytest.mark.asyncio
async def test_return_too_many_args_fails_without_signal():
    _, io, _ = await handle_return(["1", "2"], make_session(),
                                   make_function_stack())
    assert io.exit_code == 1
    assert io.stderr == b"return: too many arguments\n"


@pytest.mark.asyncio
async def test_exit_numeric_raises_signal():
    with pytest.raises(ExitSignal) as exc:
        await handle_exit(["3"], make_session())
    assert exc.value.exit_code == 3
    assert exc.value.contained_code == 3


@pytest.mark.asyncio
async def test_exit_no_arg_uses_last_exit_code():
    session = make_session()
    session.last_exit_code = 5
    with pytest.raises(ExitSignal) as exc:
        await handle_exit([], session)
    assert exc.value.exit_code == 5


@pytest.mark.asyncio
async def test_exit_wraps_status_mod_256():
    with pytest.raises(ExitSignal) as exc:
        await handle_exit(["300"], make_session())
    assert exc.value.exit_code == 44
    with pytest.raises(ExitSignal) as exc:
        await handle_exit(["-1"], make_session())
    assert exc.value.exit_code == 255


@pytest.mark.asyncio
async def test_exit_non_numeric_exits_2_with_message():
    with pytest.raises(ExitSignal) as exc:
        await handle_exit(["abc"], make_session())
    assert exc.value.exit_code == 2
    assert exc.value.stderr == b"exit: abc: numeric argument required\n"


@pytest.mark.asyncio
async def test_exit_too_many_arguments_does_not_exit():
    _, io, _ = await handle_exit(["1", "2"], make_session())
    assert io.exit_code == 1
    assert await materialize(io.stderr) == b"exit: too many arguments\n"
