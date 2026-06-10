import asyncio
import os
import shlex

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.chroma import ChromaConfig, ChromaResource

load_dotenv(".env.development")


def int_env(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None:
        return default
    return int(value)


def bool_env(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def build_resource() -> ChromaResource:
    config = ChromaConfig(
        host=os.environ.get("CHROMA_HOST", "localhost"),
        port=int_env("CHROMA_PORT", 8000),
        ssl=bool_env("CHROMA_SSL", False),
        collection_name=require_env("CHROMA_COLLECTION"),
        slug_field=os.environ.get("CHROMA_SLUG_FIELD", "page_slug"),
        chunk_index_field=os.environ.get("CHROMA_CHUNK_INDEX_FIELD",
                                         "chunk_index"),
    )
    return ChromaResource(config=config)


async def run(ws: Workspace, command: str, max_chars: int = 1000) -> str:
    result = await ws.execute(command)
    stdout = await result.stdout_str()
    stderr = (result.stderr or b"").decode(errors="replace")
    print(f"$ {command}")
    if stdout:
        output = stdout.strip()
        if len(output) > max_chars:
            output = output[:max_chars] + "\n..."
        print(output)
    if stderr:
        print(stderr.strip())
    print(f"[exit={result.exit_code}]\n")
    return stdout


async def first_document_path(ws: Workspace) -> str | None:
    output = await run(ws, "find /knowledge/ -type f | head -n 1")
    path = output.strip()
    return path or None


async def main() -> None:
    resource = build_resource()
    ws = Workspace({"/knowledge/": resource}, mode=MountMode.READ)

    print("=== Chroma Knowledge ===\n")

    await run(ws, "ls /knowledge/")
    await run(ws, "tree /knowledge/", max_chars=1500)
    await run(ws, "find /knowledge/ -type f | head -n 10")

    first_path = await first_document_path(ws)
    if first_path is None:
        print("No documents found in the Chroma path tree.")
        return

    quoted_path = shlex.quote(first_path)
    print(f"First document: {first_path}\n")

    await run(ws, f"cat {quoted_path}", max_chars=1500)
    await run(ws, f"head -n 5 {quoted_path}")
    await run(ws, f"tail -n 5 {quoted_path}")

    query = os.environ.get("CHROMA_EXAMPLE_QUERY", "getting started")
    quoted_query = shlex.quote(query)
    await run(ws, f"grep -in {quoted_query} /knowledge/", max_chars=1500)
    await run(ws,
              f"chroma-query --top-k 5 {quoted_query} /knowledge/",
              max_chars=1500)

    records = ws.ops.records
    network_bytes = ws.ops.network_bytes
    cache_bytes = ws.ops.cache_bytes
    print("=== Stats ===")
    print(f"{len(records)} ops, {network_bytes} network bytes, "
          f"{cache_bytes} cache bytes")


if __name__ == "__main__":
    asyncio.run(main())
