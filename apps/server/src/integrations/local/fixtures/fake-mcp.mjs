import * as NodeHttp from "node:http";
import * as NodeReadline from "node:readline";

let initialized = false;
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
          }),
        },
      ],
    });
  }
};

if (process.env.FIXTURE_TRANSPORT === "http") {
  const server = NodeHttp.createServer(async (request, response) => {
    if (request.url.startsWith("/oauth2callback?")) {
      response.end("connected");
      return;
    }
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
  NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
    const body = JSON.parse(line);
    handle(body, (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) + "\n"),
    );
  });
}
