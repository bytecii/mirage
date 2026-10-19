import opendal

from mirage.accessor.base import Accessor
from mirage.vfs.nextcloud.config import NextcloudConfig
from mirage.vfs.secrets import reveal_secret


class NextcloudAccessor(Accessor):
    def __init__(self, config: NextcloudConfig) -> None:
        self.config = config

    def operator(self) -> opendal.AsyncOperator:
        config = self.config
        kwargs = {"endpoint": config.url}
        username = reveal_secret(config.username)
        if username:
            kwargs["username"] = username
        password = reveal_secret(config.password)
        if password:
            kwargs["password"] = password
        return opendal.AsyncOperator("webdav", **kwargs)
