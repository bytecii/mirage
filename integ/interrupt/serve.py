import sys

import uvicorn

from mirage.server import build_app
from mirage.server.auth import AuthConfig, AuthMode

app = build_app(
    auth_config=AuthConfig(mode=AuthMode.LOCAL), state_root=sys.argv[2]
)
uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]), log_level="error")
