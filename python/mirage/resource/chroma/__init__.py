from mirage.resource.chroma.config import ChromaConfig

__all__ = ["ChromaConfig", "ChromaResource"]


def __getattr__(name: str):
    if name == "ChromaResource":
        from mirage.resource.chroma.chroma import ChromaResource
        return ChromaResource
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
