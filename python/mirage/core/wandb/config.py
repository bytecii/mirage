from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, SecretStr

Name = Annotated[str, Field(pattern=r"^[^/\\]+$", min_length=1)]


class WandbConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entities: list[Name] = Field(min_length=1)
    api_key: SecretStr = SecretStr("")
    base_url: str = "https://api.wandb.ai"
    page_size: int = Field(default=100, ge=1, le=1000)
    max_pages: int = Field(default=10000, ge=1)
