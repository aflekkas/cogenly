/** The pinned package's stdio callback also exposes attachments and a missing-state fallback.
 * Keep that listener limited to state-bearing OAuth callbacks; MCP stays on the pipe.
 */
export const googleStdioLauncher = String.raw`
import os
from urllib.parse import urlencode
from starlette.responses import PlainTextResponse
from auth.oauth_callback_server import MinimalOAuthServer

_original_init = MinimalOAuthServer.__init__
def _callback_only(self, *args, **kwargs):
    _original_init(self, *args, **kwargs)
    self.app.router.routes = [route for route in self.app.router.routes if getattr(route, "path", None) == "/oauth2callback"]
    @self.app.middleware("http")
    async def _checked_callback(request, call_next):
        if (request.method != "GET" or request.url.path != "/oauth2callback"
            or not request.query_params.get("state")
            or request.headers.get("host") != os.environ["WORKSPACE_MCP_ALLOWED_HOSTS"]):
            return PlainTextResponse("Invalid OAuth callback", status_code=400)
        allowed = {"code", "state", "scope", "error"}
        items = [(key, value) for key, value in request.query_params.multi_items() if key in allowed]
        if len({key for key, _ in items}) != len(items):
            return PlainTextResponse("Duplicate OAuth parameter", status_code=400)
        request.scope["query_string"] = urlencode(items).encode("ascii")
        return await call_next(request)
MinimalOAuthServer.__init__ = _callback_only

if __name__ == "__main__":
    from main import main
    main()
`;
