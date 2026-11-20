import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { createTelegramAdapter } from "../packages/engine/lib/bridge/telegram-adapter.ts";
import { createOutboundProxyRuntime } from "../packages/engine/lib/net/outbound-proxy.ts";

it.each([
  ["delivers wire replies without retrying uncertain sends", false],
  ["leaves an in-flight update unconfirmed on stop", true],
] as const)("uses the installed Telegram SDK and %s", async (_scenario, stopDuringProfile) => {
  const requests: { method: string; contentType: string; body: string }[] = [];
  const sender = { id: 456, first_name: "Ada", is_bot: false };
  let deliveredUpdate = false;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const method = request.url?.split("/").at(-1) || "";
    requests.push({ method, contentType: request.headers["content-type"] || "", body });

    function reply(result: unknown, status = 200) {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, result }));
    }

    if (method === "getMe") {
      reply({ id: 1, username: "hana_bot", first_name: "Hana", is_bot: true });
    } else if (method === "getUpdates") {
      if (!deliveredUpdate) {
        deliveredUpdate = true;
        reply([{ update_id: 41, message: {
          message_id: 1, date: 1, text: "from Telegram",
          chat: { id: 456, type: "private" }, from: sender,
        } }]);
      } else if (new URLSearchParams(body).get("timeout") === "0") {
        reply([]);
      }
      // Hold the next ordinary poll open until the adapter stops it.
    } else if (method === "getUserProfilePhotos") {
      if (!stopDuringProfile) reply({ total_count: 0, photos: [] });
    } else if (method === "sendMessage") {
      reply(null, 502);
    } else {
      reply(true);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const runtime = createOutboundProxyRuntime();
  runtime.apply({ mode: "direct" });

  const fetch = globalThis.fetch;
  const redirectToLoopback = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const source = new URL(String(input));
    if (source.origin !== "https://api.telegram.org") throw new Error("Unexpected outbound request");
    return fetch(new URL(source.pathname, origin), init);
  });
  const onMessage = vi.fn();
  const onStatus = vi.fn();
  const adapter = createTelegramAdapter({ token: "test-token", agentId: "hana", onMessage, onStatus });

  try {
    if (stopDuringProfile) {
      await vi.waitFor(() => expect(requests.some(request => request.method === "getUserProfilePhotos")).toBe(true));
      await adapter.stop();
      expect(onMessage).not.toHaveBeenCalled();
      expect(requests.some(request => request.method === "getUpdates"
        && new URLSearchParams(request.body).get("offset") === "42")).toBe(false);
      return;
    }
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: "from Telegram",
      sessionKey: "tg_dm_456@hana",
    })));
    expect(onStatus).toHaveBeenCalledWith("connected");

    await adapter.sendRichDraft("456", "**Hello**", { draftId: 12 });
    await adapter.sendRichReply("456", "**Final**");
    await adapter.sendMediaBuffer("456", Buffer.from("attachment contents"), {
      filename: "fixture.txt", mime: "text/plain",
    });
    await expect(adapter.sendReply("456", "only once")).rejects.toThrow("Server error 502 on sendMessage");

    const draft = requests.find(request => request.method === "sendRichMessageDraft");
    const draftParams = new URLSearchParams(draft?.body);
    expect(draftParams.get("draft_id")).toBe("12");
    expect(draftParams.get("rich_message")).toBe('{"markdown":"**Hello**"}');
    const final = requests.find(request => request.method === "sendRichMessage");
    expect(new URLSearchParams(final?.body).get("rich_message")).toBe('{"markdown":"**Final**"}');
    const upload = requests.find(request => request.method === "sendDocument");
    expect(upload?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(upload?.body).toContain('name="document"; filename="fixture.txt"');
    expect(upload?.body).toContain("Content-Type: text/plain\r\n\r\nattachment contents");
    expect(requests.filter(request => request.method === "sendMessage")).toHaveLength(1);

    await adapter.stop();
    expect(requests.some(request => {
      const params = new URLSearchParams(request.body);
      return request.method === "getUpdates" && params.get("offset") === "42" && params.get("timeout") === "0";
    })).toBe(true);
  } finally {
    await adapter.stop();
    redirectToLoopback.mockRestore();
    runtime.reset();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
