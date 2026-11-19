import { createServer } from "node:http";
import { expect, it } from "vitest";
import { authenticateDeviceServer } from "../apps/desktop/src/shared/device-connection-handshake.cjs";

it("authenticates the exact device endpoint and stops before a credential redirect", async () => {
  const requests: Array<{ path: string; authorization?: string; text: string }> = [];
  let redirectLogin = false;
  const server = createServer(async (request, response) => {
    const body = [];
    for await (const bytes of request) body.push(bytes);
    requests.push({
      path: request.url!, authorization: request.headers.authorization, text: Buffer.concat(body).toString("utf8"),
    });
    if (redirectLogin && request.url?.endsWith("/login")) {
      response.writeHead(307, { Location: "/other-origin-shape" }).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url?.endsWith("/identity") ? { serverNodeId: "server-fixture" } : { ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}/hana`;
    await expect(authenticateDeviceServer(base, "fixture-key", fetch)).resolves.toEqual({ serverNodeId: "server-fixture" });
    expect(requests).toEqual([
      { path: "/hana/api/web-auth/login", authorization: undefined, text: JSON.stringify({ credential: "fixture-key" }) },
      { path: "/hana/api/server/identity", authorization: "Bearer fixture-key", text: "" },
    ]);

    redirectLogin = true;
    await expect(authenticateDeviceServer(base, "fixture-key", fetch)).rejects.toThrow();
    expect(requests.map(({ path }) => path)).toEqual([
      "/hana/api/web-auth/login", "/hana/api/server/identity", "/hana/api/web-auth/login",
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
