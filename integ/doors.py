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
over stdio, `mirage execute`, `ssh` exec, the SSH `mcp` subsystem, `sftp`,
and the HTTP API again. Then the daemon's own records are read: every MCP `shell` call
is a job, the SSH sessions closed with their channels, a `mirage mcp`
workspace with no name went with its process, and the MCP endpoint refuses
a request with no token. Both hosts must give the expected answers.
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


def wait_until(check: Callable[[], bool], timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not check() and time.monotonic() < deadline:
        time.sleep(0.05)


async def probe(host: str, root: Path) -> dict[str, str]:
    """Walk one workspace through every door of one host's daemon.

    Args:
        host (str): ``python`` or ``typescript``.
        root (Path): a private directory for this host.

    Returns:
        dict[str, str]: one answer per probe, keyed as ``EXPECTED`` is.
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

        def execute(command: str) -> str:
            response = api.post(
                f"{workspace}/execute", json={"command": command}
            )
            response.raise_for_status()
            return response.json()["stdout"]

        def workspaces() -> int:
            return len(api.get("/v1/workspaces").json())

        def ssh_sessions() -> list[str]:
            rows = api.get(f"{workspace}/sessions").json()
            ids = [row.get("session_id", row.get("sessionId")) for row in rows]
            return [i for i in ids if i.startswith("ssh_")]

        execute("echo from-http > /http.txt")

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
                "execute",
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
        got["http.reads_sftp"] = execute("cat /sftp.txt")

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
    return got


def main() -> int:
    failures = 0
    with tempfile.TemporaryDirectory(prefix="mirage-doors-") as tmp:
        for host in ("python", "typescript"):
            root = Path(tmp) / host
            root.mkdir()
            got = asyncio.run(probe(host, root))
            for key, want in EXPECTED.items():
                answer = got.get(key)
                if answer == want:
                    print(f"ok   {host:<10} {key}")
                else:
                    failures += 1
                    print(
                        f"FAIL {host:<10} {key}: got {answer!r}, want {want!r}"
                    )
    print(f"{failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
