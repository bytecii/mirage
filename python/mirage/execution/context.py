from mirage.utils.ids import uuid7


def new_execution_id() -> str:
    return f"exec_{uuid7()}"
