import argparse
import json
import sys
import urllib.request
from pathlib import Path
from typing import TypeAlias

JsonValue: TypeAlias = (
    None
    | bool
    | int
    | float
    | str
    | list["JsonValue"]
    | dict[str, "JsonValue"]
)
ROOT = Path(__file__).resolve().parents[1]
ENDPOINT = "https://docs.mirage.strukto.ai/mcp"
KNOWN_PAGE = "/home/install.mdx"
KNOWN_PAGE_URL = "https://docs.mirage.strukto.ai/home/install"


def mapping(value: JsonValue) -> dict[str, JsonValue]:
    """Require a JSON object from a protocol response.

    Args:
        value (JsonValue): the decoded response field.
    """
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object, got {value!r}")
    return value


def rpc(
    method: str, params: dict[str, JsonValue], *, notification: bool = False
) -> dict[str, JsonValue]:
    """Read a JSON or SSE response from the public, stateless endpoint.

    Args:
        method (str): the MCP request method.
        params (dict[str, JsonValue]): its parameters.
        notification (bool): omit the request ID and expect no response.
    """
    payload: dict[str, JsonValue] = {
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    }
    if not notification:
        payload["id"] = 1
    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read().decode()
        content_type = response.headers.get_content_type()
    if notification:
        return {}
    messages = [raw]
    if content_type == "text/event-stream":
        messages = [
            "\n".join(
                line[5:].lstrip()
                for line in event.splitlines()
                if line.startswith("data:")
            )
            for event in raw.replace("\r\n", "\n").split("\n\n")
        ]
    for message in messages:
        if not message:
            continue
        payload = mapping(json.loads(message))
        if payload.get("id") != 1:
            continue
        if "error" in payload:
            raise ValueError(f"{method}: {payload['error']}")
        return mapping(payload.get("result"))
    raise ValueError(f"{method}: no JSON-RPC response")


def call_tool(name: str, arguments: dict[str, JsonValue]) -> str:
    """Return all text blocks, rejecting tool-level failures.

    Args:
        name (str): the read-only tool to call.
        arguments (dict[str, JsonValue]): its arguments.
    """
    result = rpc("tools/call", {"name": name, "arguments": arguments})
    if result.get("isError"):
        raise ValueError(f"{name}: {result}")
    content = result.get("content")
    if not isinstance(content, list):
        raise ValueError(f"{name}: missing content")
    return "\n".join(
        str(block["text"])
        for block in content
        if isinstance(block, dict) and isinstance(block.get("text"), str)
    )


def check_config() -> None:
    """Check the candidate site's MCP option and documented smoke target."""
    config = mapping(json.loads((ROOT / "docs/docs.json").read_text()))
    options = mapping(config.get("contextual")).get("options")
    if not isinstance(options, list) or "mcp" not in options:
        raise ValueError("docs/docs.json does not enable contextual MCP")
    if not (ROOT / "docs" / KNOWN_PAGE.lstrip("/")).is_file():
        raise ValueError(f"smoke target {KNOWN_PAGE} is absent locally")
    if "home/docs-mcp" not in json.dumps(config.get("navigation")):
        raise ValueError("docs MCP page is absent from navigation")


def main() -> int:
    """Validate the candidate configuration, optionally checking the deployment."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config-only", action="store_true")
    args = parser.parse_args()
    try:
        check_config()
        if not args.config_only:
            rpc(
                "initialize",
                {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {
                        "name": "mirage-docs-smoke",
                        "version": "1.0",
                    },
                },
            )
            rpc("notifications/initialized", {}, notification=True)
            tools = rpc("tools/list", {}).get("tools")
            if not isinstance(tools, list):
                raise ValueError("missing tool list")
            names = {
                str(mapping(tool)["name"])
                for tool in tools
                if isinstance(mapping(tool).get("name"), str)
            }
            if not {"search_mirage", "query_docs_filesystem_mirage"} <= names:
                raise ValueError(
                    "missing documentation search or retrieval tool"
                )
            retrieved = call_tool(
                "query_docs_filesystem_mirage",
                {"command": f"head -20 {KNOWN_PAGE}"},
            )
            if "Installation" not in retrieved:
                raise ValueError(
                    f"{KNOWN_PAGE} did not return its title: {retrieved}"
                )
            search = call_tool("search_mirage", {"query": "install mirage"})
            if KNOWN_PAGE_URL not in search:
                raise ValueError(
                    f"search did not return {KNOWN_PAGE_URL}: {search}"
                )
    except (OSError, ValueError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    print(
        "OK: docs MCP configuration"
        if args.config_only
        else "OK: docs MCP initialization, discovery, retrieval and search"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
