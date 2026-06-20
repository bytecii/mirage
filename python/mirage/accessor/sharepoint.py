from collections.abc import Callable

from pydantic import BaseModel, ConfigDict, SecretStr

from mirage.accessor.base import Accessor


class SharePointConfig(BaseModel):
    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    access_token: SecretStr | Callable[[], str | SecretStr]
    tenant_host: str | None = None
    site_filter: str | None = None
    timeout: int = 30
    max_retries: int = 5


class SharePointAccessor(Accessor):

    def __init__(self, config: SharePointConfig) -> None:
        self.config = config
