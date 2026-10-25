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

# Install the store before importing main or any Google service. Nothing writes tokens to disk.
import json
from datetime import datetime
from urllib.request import Request, urlopen
from google.oauth2.credentials import Credentials
from auth.credential_store import CredentialStore, set_credential_store

class CogenlyVaultStore(CredentialStore):
    def _request(self, operation, **values):
        request = Request(os.environ["COGENLY_GOOGLE_CREDENTIAL_URL"],
            data=json.dumps({"operation": operation, **values}).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + os.environ["COGENLY_GOOGLE_CREDENTIAL_CAPABILITY"]}, method="POST")
        with urlopen(request, timeout=15) as response:
            return json.load(response)
    def get_credential(self, user_email):
        grant = self._request("read").get("grant")
        if not grant or grant["email"] != user_email:
            return None
        data = grant["credentials"]
        expiry = datetime.fromisoformat(data["expiry"]).replace(tzinfo=None) if data.get("expiry") else None
        return Credentials(token=data.get("token"), refresh_token=data.get("refresh_token"), token_uri=data["token_uri"],
            client_id=data["client_id"], client_secret=data["client_secret"], scopes=data.get("scopes"), expiry=expiry)
    def store_credential(self, user_email, credentials):
        self._request("write", grant={"email": user_email, "credentials": {
            "token": credentials.token, "refresh_token": credentials.refresh_token,
            "token_uri": credentials.token_uri, "client_id": credentials.client_id,
            "client_secret": credentials.client_secret, "scopes": list(credentials.scopes) if credentials.scopes else None,
            "expiry": credentials.expiry.isoformat() if credentials.expiry else None}})
        return True
    def delete_credential(self, user_email):
        self._request("remove")
        return True
    def list_users(self):
        grant = self._request("read").get("grant")
        return [grant["email"]] if grant else []

set_credential_store(CogenlyVaultStore())

if __name__ == "__main__":
    from main import main
    main()
`;
