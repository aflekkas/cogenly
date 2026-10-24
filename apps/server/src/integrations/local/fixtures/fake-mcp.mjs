import * as NodeNet from "node:net";
import * as NodeHttp from "node:http";
import * as NodeReadline from "node:readline";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";

if (process.env.FIXTURE_LIVENESS_PORT) {
  NodeNet.connect(Number(process.env.FIXTURE_LIVENESS_PORT), "127.0.0.1");
}

let initialized = false;
let authCount = 0;
const authStates = new Set();
const handle = (body, reply) => {
  if (body.method === "initialize") {
    reply({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1" },
    });
  } else if (body.method === "notifications/initialized") {
    initialized = true;
  } else if (!initialized) {
    throw new Error("Missing initialized notification");
  } else if (body.method === "tools/list") {
    reply({ tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] });
  } else if (body.params?.name === "start_google_auth") {
    authCount++;
    const state = NodeCrypto.randomUUID();
    authStates.add(state);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", process.env.GOOGLE_OAUTH_REDIRECT_URI);
    reply({ content: [{ type: "text", text: `Open [Google sign-in](${url.href})` }] });
  } else if (body.params?.name === "forged-google-auth") {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("state", "forged");
    url.searchParams.set("redirect_uri", process.env.GOOGLE_OAUTH_REDIRECT_URI);
    reply({ content: [{ type: "text", text: url.href }] });
  } else if (body.params?.name === "tool-error") {
    reply({
      isError: true,
      content: [
        { type: "text", text: `Workspace permission denied for ${process.env.FIXTURE_SECRET}` },
      ],
    });
  } else if (body.params?.name === "reject-grant") {
    reply({
      isError: true,
      content: [{ type: "text", text: "invalid_grant: Token has been expired or revoked." }],
    });
  } else if (body.params?.name === "reject-grant-output") {
    process.stderr.write(
      "google.auth.exceptions.RefreshError: invalid_grant: Token has been expired or revoked.\n",
    );
    reply({ content: [] });
  } else if (body.params?.name === "crash") {
    process.stderr.write("crashing with " + process.env.FIXTURE_SECRET.slice(0, 5));
    process.stderr.write(process.env.FIXTURE_SECRET.slice(5) + "\n");
    process.exit(17);
  } else {
    reply({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            args: body.params?.arguments,
            argv: process.argv,
            secretPresent: Boolean(process.env.FIXTURE_SECRET),
            pid: process.pid,
            authCount,
          }),
        },
      ],
    });
  }
};

const callback = (request, response) => {
  if (request.url.startsWith("/oauth2callback?")) {
    if (process.env.WORKSPACE_MCP_CREDENTIALS_DIR) {
      const state = new URL(request.url, "http://localhost").searchParams.get("state");
      if (!authStates.delete(state)) {
        response.writeHead(400).end();
        return true;
      }
      NodeFS.writeFileSync(
        `${process.env.WORKSPACE_MCP_CREDENTIALS_DIR}/fixture@example.com.json`,
        JSON.stringify({ refresh_token: "fixture-only" }),
        { mode: 0o600 },
      );
    }
    response.end("connected");
    return true;
  }

  return false;
};

if (process.env.FIXTURE_TRANSPORT === "http") {
  const server = NodeHttp.createServer(async (request, response) => {
    if (callback(request, response)) return;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.id === undefined) {
      handle(body, () => {});
      response.writeHead(202).end();
      return;
    }
    handle(body, (result) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "fixture-session",
      });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  server.listen(Number(process.env.FIXTURE_PORT), "127.0.0.1");
} else {
  if (process.env.WORKSPACE_MCP_CREDENTIALS_DIR) {
    NodeHttp.createServer((request, response) => {
      if (!callback(request, response)) response.writeHead(404).end();
    }).listen(Number(process.env.FIXTURE_PORT), "127.0.0.1");
  }
  NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
    const body = JSON.parse(line);
    handle(body, (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) + "\n"),
    );
  });
}
