import asyncio
import os
import sys

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


def first_file(vos, directory: str) -> str | None:
    entries = vos.listdir(directory)
    for entry in entries:
        path = f"{directory.rstrip('/')}/{entry}"
        if vos.path.isdir(path):
            found = first_file(vos, path)
            if found is not None:
                return found
        elif vos.path.isfile(path):
            return path
    return None


async def main() -> None:
    resource = build_resource()
    with Workspace({"/knowledge/": resource}, mode=MountMode.READ) as ws:
        vos = sys.modules["os"]

        print("=== Chroma VFS ===\n")

        print("--- os.listdir('/knowledge') ---")
        for entry in vos.listdir("/knowledge")[:20]:
            print(f"  {entry}")

        path = first_file(vos, "/knowledge")
        if path is None:
            print("\nNo documents found in the Chroma path tree.")
            return

        print(f"\n--- open('{path}') ---")
        with open(path) as file:
            content = file.read()
        preview = content[:1500]
        print(preview)
        if len(content) > len(preview):
            print("...")

        print("\n--- os.path metadata ---")
        print(f"  exists: {vos.path.exists(path)}")
        print(f"  isfile: {vos.path.isfile(path)}")
        print(f"  size: {vos.path.getsize(path)}")

        records = ws.ops.records
        total = sum(record.bytes for record in records)
        print(f"\nStats: {len(records)} ops, {total} bytes transferred")


if __name__ == "__main__":
    asyncio.run(main())
