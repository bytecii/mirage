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
"""Every door of the daemon reaches the same workspace, on both hosts.

Run from the repository root after building TypeScript packages:
    ./python/.venv/bin/python integ/doors.py

The tools and commands behind each door have their own unit tests; this
checks the wiring only, on the Python host and the TypeScript host, each
with its own daemon and its own `mirage` CLI. Each daemon gets a private
home, HTTP port and SSH port. `mirage workspace create` makes one
workspace, which is written through each door in turn and read back
through the next: the HTTP API, MCP over the HTTP endpoint, `mirage mcp`
over stdio, `mirage shell`, `ssh` exec, the SSH `mcp` subsystem, `sftp`,
and the HTTP API again. Then the daemon's own records are read: every MCP `shell` call
is a job, the SSH sessions closed with their channels, a `mirage mcp`
workspace with no name went with its process, and the MCP endpoint refuses
a request with no token. Both hosts must give the expected answers.

Then the tool corpus (integ/tools/cases.json, whose in-app door is
integ/tools/run.py and run.ts) runs through each daemon door, each on a
fresh workspace built by the corpus setup: the HTTP routes (POST /shell
and the tool routes), the CLI (mirage shell and the tool verbs), MCP over
HTTP, and SSH (ssh exec for shell, the mcp subsystem for the rest). Every
door must give every case's answer.
"""

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

import httpx
import httpx2
from mcp import Client, StdioServerParameters
from mcp.client.streamable_http import streamable_http_client

ROOT = Path(__file__).resolve().parents[1]
SUITE = json.loads((ROOT / "integ" / "tools" / "cases.json").read_text())
DOORS = ("http", "cli", "mcp", "ssh")
TOKEN = "doors-integ"
WORKSPACE = "doors"
RAM = "mounts:\n  /:\n    vfs: ram\n    mode: write\n"
TOOLS = "edit glob grep ls read shell write"
EXPECTED = {
    "mcp_http.tools": TOOLS,
    "mcp_http.reads_http": "from-http\n",
    "mcp_stdio.tools": TOOLS,
    "mcp_stdio.reads_mcp_http": "from-mcp-http\n",
    "cli.reads_mcp_stdio": "from-mcp-stdio\n",
    "ssh.reads_cli": "from-cli\n",
    "ssh_mcp.tools": TOOLS,
    "ssh_mcp.reads_ssh": "from-ssh\n",
    "sftp.reads_ssh_mcp": "from-ssh-mcp\n",
    "http.reads_sftp": "from-sftp\n",
    "jobs.mcp_shell_calls": "6",
    "sessions.ssh_left_open": "",
    "mcp_stdio.unnamed_while_open": "2",
    "mcp_stdio.unnamed_after_close": "1",
    "mcp_http.without_token": "401",
}


def free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


@contextmanager
def daemon(host: str, root: Path) -> Iterator[dict[str, str]]:
    """Run one host's daemon with its HTTP and SSH doors open.

    Args:
        host (str): ``python`` or ``typescript``.
        root (Path): a private directory for the home, keys and log.

    Yields:
        dict[str, str]: the environment a CLI uses to reach it, with the
            SSH port and client key beside it.
    """
    port, ssh_port = free_port(), free_port()
    key = root / "id_ed25519"
    subprocess.run(
        ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key)],
        check=True,
    )
    shutil.copy(root / "id_ed25519.pub", root / "authorized_keys")
    env = {
        **os.environ,
        "MIRAGE_HOME": str(root / "home"),
        "MIRAGE_DAEMON_PORT": str(port),
        "MIRAGE_DAEMON_URL": f"http://127.0.0.1:{port}",
        "MIRAGE_AUTH_MODE": "token",
        "MIRAGE_AUTH_TOKEN": TOKEN,
        "MIRAGE_TOKEN": TOKEN,
        "MIRAGE_IDLE_GRACE_SECONDS": "600",
        "MIRAGE_SSH_PORT": str(ssh_port),
        "MIRAGE_SSH_HOST_KEY_FILE": str(root / "host_key"),
        "MIRAGE_SSH_AUTHORIZED_KEYS": str(root / "authorized_keys"),
    }
    command = (
        [
            sys.executable,
            "-m",
            "uvicorn",
            "mirage.server.daemon:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ]
        if host == "python"
        else [
            "node",
            str(ROOT / "typescript/packages/server/dist/bin/daemon.js"),
        ]
    )
    with (root / "daemon.log").open("w+") as log:
        process = subprocess.Popen(
            command, cwd=ROOT, env=env, stdout=log, stderr=log
        )
        try:
            deadline = time.monotonic() + 30
            while not _ready(env["MIRAGE_DAEMON_URL"], ssh_port):
                if process.poll() is not None or time.monotonic() > deadline:
                    log.seek(0)
                    raise RuntimeError(
                        f"{host} daemon did not start:\n{log.read()}"
                    )
                time.sleep(0.05)
            yield {**env, "SSH_PORT": str(ssh_port), "SSH_KEY": str(key)}
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def _ready(url: str, ssh_port: int) -> bool:
    try:
        health = httpx.get(
            f"{url}/v1/health",
            headers={"Authorization": f"Bearer {TOKEN}"},
            timeout=1,
        )
        with socket.create_connection(("127.0.0.1", ssh_port), timeout=1):
            return health.status_code == 200
    except (httpx.TransportError, OSError):
        return False


def mirage_cli(host: str, *args: str) -> list[str]:
    if host == "python":
        return [str(Path(sys.executable).parent / "mirage"), *args]
    return [
        "node",
        str(ROOT / "typescript/packages/cli/dist/bin/mirage.js"),
        *args,
    ]


def ssh_command(
    env: dict[str, str], *args: str, program: str = "ssh"
) -> list[str]:
    port_flag = "-P" if program == "sftp" else "-p"
    return [
        program,
        "-F",
        "/dev/null",
        port_flag,
        env["SSH_PORT"],
        "-i",
        env["SSH_KEY"],
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "LogLevel=ERROR",
        *args,
    ]


def stdio(command: list[str], env: dict[str, str]) -> StdioServerParameters:
    return StdioServerParameters(
        command=command[0], args=command[1:], env=env, cwd=str(ROOT)
    )


async def tool_names(client: Client) -> str:
    return " ".join(sorted(t.name for t in (await client.list_tools()).tools))


async def shell(client: Client, command: str) -> str:
    result = await client.call_tool("shell", {"command": command})
    text = result.content[0].text if result.content else ""
    if result.is_error:
        raise RuntimeError(f"shell {command!r} failed: {text}")
    return text


async def run(
    command: list[str],
    stdin: str | None = None,
    env: dict[str, str] | None = None,
) -> str:
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=ROOT,
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await process.communicate(
        stdin.encode() if stdin is not None else None
    )
    if process.returncode != 0:
        raise RuntimeError(
            f"{command[0]} exited {process.returncode}: {err!r}"
        )
    return out.decode()


async def run_raw(
    command: list[str], env: dict[str, str] | None = None
) -> tuple[int, str, str]:
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=ROOT,
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await process.communicate(b"")
    return process.returncode or 0, out.decode(), err.decode()


def shell_answer(stdout: str, stderr: str, code: int) -> tuple[str, bool]:
    """A shell line's answer as the shell tool gives it.

    Args:
        stdout (str): the line's stdout.
        stderr (str): the line's stderr.
        code (int): its exit status.

    Returns:
        tuple[str, bool]: stdout, then stderr, and whether it failed.
    """
    text = f"{stdout}\n{stderr}" if stdout and stderr else stdout or stderr
    return text, code != 0


def io_answer(reply: dict) -> tuple[str, bool]:
    code = reply.get("exit_code", reply.get("exitCode"))
    return shell_answer(reply["stdout"], reply["stderr"], int(code))


def tool_answer(reply: dict) -> tuple[str, bool]:
    return reply["text"], bool(reply.get("is_error", reply.get("isError")))


def cli_args(tool: str, args: dict) -> list[str]:
    """A tool's JSON input as its CLI verb's arguments.

    Args:
        tool (str): the tool.
        args (dict): its input.

    Returns:
        list[str]: the verb's flags and operands.
    """
    if tool == "read":
        words = [args["path"]]
        for key in ("offset", "limit"):
            if key in args:
                words += [f"--{key}", str(args[key])]
        return words
    if tool == "write":
        return [args["path"], "--content", args["content"]]
    if tool == "edit":
        words = [args["path"], args["old_string"], args["new_string"]]
        return words + (["--replace-all"] if args.get("replace_all") else [])
    if tool == "ls":
        return [args["path"]]
    if tool == "glob":
        return [args["pattern"], args.get("path", "/")]
    flags = {
        "ignore_case": "-i",
        "fixed_strings": "-F",
        "files_with_matches": "-l",
        "count": "-c",
    }
    words = [flag for key, flag in flags.items() if args.get(key)]
    for key, flag in (("include", "--include"), ("context", "-C")):
        if key in args:
            words += [flag, str(args[key])]
    if "max_count" in args:
        words += ["-m", str(args["max_count"])]
    return words + [args["pattern"], args["path"]]


async def corpus(
    host: str, env: dict[str, str], api: httpx.Client
) -> dict[str, list[tuple[str, bool]]]:
    """Run the tool corpus through each daemon door.

    Args:
        host (str): ``python`` or ``typescript``.
        env (dict[str, str]): the environment reaching this host's daemon.
        api (httpx.Client): an authenticated client of its HTTP API.

    Returns:
        dict[str, list[tuple[str, bool]]]: per door, each case's answer.
    """
    answers: dict[str, list[tuple[str, bool]]] = {}
    auth = {"Authorization": f"Bearer {TOKEN}"}
    for door in DOORS:
        wid = f"tools-{door}"
        created = api.post(
            "/v1/workspaces",
            json={
                "id": wid,
                "config": {"mounts": {"/": {"vfs": "ram", "mode": "write"}}},
            },
        )
        created.raise_for_status()
        for line in SUITE["setup"]:
            api.post(
                f"/v1/workspaces/{wid}/shell", json={"command": line}
            ).raise_for_status()
        got: list[tuple[str, bool]] = []
        if door == "http":
            for case in SUITE["cases"]:
                route = case["tool"]
                reply = api.post(
                    f"/v1/workspaces/{wid}/{route}", json=case["input"]
                )
                reply.raise_for_status()
                got.append(
                    io_answer(reply.json())
                    if route == "shell"
                    else tool_answer(reply.json())
                )
        elif door == "cli":
            for case in SUITE["cases"]:
                tool, args = case["tool"], case["input"]
                if tool == "shell":
                    command = mirage_cli(
                        host, "shell", "-w", wid, "-c", args["command"]
                    )
                else:
                    command = mirage_cli(
                        host, tool, "-w", wid, *cli_args(tool, args)
                    )
                _, out, _ = await run_raw(command, env)
                reply = json.loads(out)
                got.append(
                    io_answer(reply) if tool == "shell" else tool_answer(reply)
                )
        elif door == "mcp":
            url = f"{env['MIRAGE_DAEMON_URL']}/v1/workspaces/{wid}/mcp"
            async with (
                httpx2.AsyncClient(headers=auth) as http,
                Client(
                    streamable_http_client(url, http_client=http)
                ) as client,
            ):
                for case in SUITE["cases"]:
                    result = await client.call_tool(
                        case["tool"], case["input"]
                    )
                    text = result.content[0].text if result.content else ""
                    got.append((text, bool(result.is_error)))
        else:
            login = f"{wid}@127.0.0.1"
            subsystem = ssh_command(env, "-T", login, "-s", "mcp")
            async with Client(stdio(subsystem, env)) as client:
                for case in SUITE["cases"]:
                    if case["tool"] == "shell":
                        command = ssh_command(
                            env, "-T", login, case["input"]["command"]
                        )
                        code, out, err = await run_raw(command)
                        got.append(shell_answer(out, err, code))
                        continue
                    result = await client.call_tool(
                        case["tool"], case["input"]
                    )
                    text = result.content[0].text if result.content else ""
                    got.append((text, bool(result.is_error)))
        answers[door] = got
    return answers


def wait_until(check: Callable[[], bool], timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not check() and time.monotonic() < deadline:
        time.sleep(0.05)


async def probe(
    host: str, root: Path
) -> tuple[dict[str, str], dict[str, list[tuple[str, bool]]]]:
    """Walk one workspace through every door of one host's daemon.

    Args:
        host (str): ``python`` or ``typescript``.
        root (Path): a private directory for this host.

    Returns:
        tuple[dict[str, str], dict[str, list[tuple[str, bool]]]]: one
            answer per wiring probe, keyed as ``EXPECTED`` is, and the
            corpus answers per door.
    """
    got: dict[str, str] = {}
    auth = {"Authorization": f"Bearer {TOKEN}"}
    with (
        daemon(host, root) as env,
        httpx.Client(
            base_url=env["MIRAGE_DAEMON_URL"], headers=auth, timeout=60
        ) as api,
    ):
        base = env["MIRAGE_DAEMON_URL"]
        workspace = f"/v1/workspaces/{WORKSPACE}"
        config = root / "workspace.yaml"
        config.write_text(RAM)
        await run(
            mirage_cli(
                host, "workspace", "create", str(config), "--id", WORKSPACE
            ),
            env=env,
        )

        def http_shell(command: str) -> str:
            response = api.post(
                f"{workspace}/shell", json={"command": command}
            )
            response.raise_for_status()
            return response.json()["stdout"]

        def workspaces() -> int:
            return len(api.get("/v1/workspaces").json())

        def ssh_sessions() -> list[str]:
            rows = api.get(f"{workspace}/sessions").json()
            ids = [row.get("session_id", row.get("sessionId")) for row in rows]
            return [i for i in ids if i.startswith("ssh_")]

        http_shell("echo from-http > /http.txt")

        mcp_url = f"{base}{workspace}/mcp"
        async with (
            httpx2.AsyncClient(headers=auth) as http,
            Client(
                streamable_http_client(mcp_url, http_client=http)
            ) as client,
        ):
            got["mcp_http.tools"] = await tool_names(client)
            got["mcp_http.reads_http"] = await shell(client, "cat /http.txt")
            await shell(client, "echo from-mcp-http > /mcp-http.txt")
        got["mcp_http.without_token"] = str(
            httpx.post(mcp_url, json={}, timeout=10).status_code
        )

        relay = mirage_cli(host, "mcp", "-w", WORKSPACE)
        async with Client(stdio(relay, env)) as client:
            got["mcp_stdio.tools"] = await tool_names(client)
            got["mcp_stdio.reads_mcp_http"] = await shell(
                client, "cat /mcp-http.txt"
            )
            await shell(client, "echo from-mcp-stdio > /mcp-stdio.txt")

        executed = await run(
            mirage_cli(
                host,
                "shell",
                "-w",
                WORKSPACE,
                "-c",
                "cat /mcp-stdio.txt; echo from-cli > /cli.txt",
            ),
            stdin="",
            env=env,
        )
        reply = json.loads(executed)
        got["cli.reads_mcp_stdio"] = reply.get(
            "stdout", reply.get("result", {}).get("stdout")
        )

        login = f"{WORKSPACE}@127.0.0.1"
        got["ssh.reads_cli"] = await run(
            ssh_command(
                env, "-T", login, "cat /cli.txt; echo from-ssh > /ssh.txt"
            )
        )

        subsystem = ssh_command(env, "-T", login, "-s", "mcp")
        async with Client(stdio(subsystem, env)) as client:
            got["ssh_mcp.tools"] = await tool_names(client)
            got["ssh_mcp.reads_ssh"] = await shell(client, "cat /ssh.txt")
            await shell(client, "echo from-ssh-mcp > /ssh-mcp.txt")

        (root / "put.txt").write_text("from-sftp\n")
        batch = (
            f"get /ssh-mcp.txt {root / 'got.txt'}\n"
            f"put {root / 'put.txt'} /sftp.txt\n"
        )
        await run(ssh_command(env, "-b", "-", login, program="sftp"), batch)
        got["sftp.reads_ssh_mcp"] = (root / "got.txt").read_text()
        got["http.reads_sftp"] = http_shell("cat /sftp.txt")

        commands = {row["command"] for row in api.get("/v1/jobs").json()}
        mcp_calls = [
            "cat /http.txt",
            "echo from-mcp-http > /mcp-http.txt",
            "cat /mcp-http.txt",
            "echo from-mcp-stdio > /mcp-stdio.txt",
            "cat /ssh.txt",
            "echo from-ssh-mcp > /ssh-mcp.txt",
        ]
        got["jobs.mcp_shell_calls"] = str(
            sum(c in commands for c in mcp_calls)
        )

        wait_until(lambda: not ssh_sessions())
        got["sessions.ssh_left_open"] = " ".join(ssh_sessions())

        unnamed = root / "unnamed.yaml"
        unnamed.write_text(RAM)
        async with Client(stdio(mirage_cli(host, "mcp", str(unnamed)), env)):
            got["mcp_stdio.unnamed_while_open"] = str(workspaces())
        wait_until(lambda: workspaces() == 1)
        got["mcp_stdio.unnamed_after_close"] = str(workspaces())
        answers = await corpus(host, env, api)
    return got, answers


def main() -> int:
    failures = 0
    with tempfile.TemporaryDirectory(prefix="mirage-doors-") as tmp:
        for host in ("python", "typescript"):
            root = Path(tmp) / host
            root.mkdir()
            got, answers = asyncio.run(probe(host, root))
            for key, want in EXPECTED.items():
                answer = got.get(key)
                if answer == want:
                    print(f"ok   {host:<10} {key}")
                else:
                    failures += 1
                    print(
                        f"FAIL {host:<10} {key}: got {answer!r}, want {want!r}"
                    )
            for door, door_answers in answers.items():
                passed = 0
                for case, (text, is_error) in zip(
                    SUITE["cases"], door_answers, strict=True
                ):
                    want = case["expect"]
                    if [text, is_error] == [want["text"], want["is_error"]]:
                        passed += 1
                        continue
                    failures += 1
                    print(
                        f"FAIL {host:<10} tools.{door}.{case['id']}: "
                        f"got {(text, is_error)!r}, want {want!r}"
                    )
                print(
                    f"ok   {host:<10} tools.{door} "
                    f"{passed}/{len(SUITE['cases'])}"
                )
    print(f"{failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
