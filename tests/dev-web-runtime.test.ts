import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import {
  buildDevWebClientConfig,
  buildDevWebPreviewUrl,
  normalizeServerInfoForDevWeb,
  resolveDevWebEnvironment,
  resolveViteCommand,
} from "../scripts/dev-web-runtime.js";

describe("dev-web runtime helpers", () => {
  it("expands a quoted tilde home before sharing it with the server child", () => {
    const input = { HANA_HOME: "~/hana-independent", HANA_DEV_NODE_BIN: "/tmp/hana-node" };
    const env = resolveDevWebEnvironment(input);

    expect(env.HANA_HOME).toBe(path.join(homedir(), "hana-independent"));
    expect(env.HANA_DEV_NODE_BIN).toBe("/tmp/hana-node");
    expect(input.HANA_HOME).toBe("~/hana-independent");
  });

  it("resolves a relative home from the invoking directory before the server changes cwd", () => {
    const moduleUrl = new URL("../scripts/dev-web-runtime.js", import.meta.url).href;
    const script = `import { resolveDevWebEnvironment } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify(resolveDevWebEnvironment({ HANA_HOME: "hana-relative" })));`;
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: tmpdir(),
      encoding: "utf8",
    });

    expect(JSON.parse(output).HANA_HOME).toBe(path.join(realpathSync(tmpdir()), "hana-relative"));
  });

  it("keeps an absolute isolated home unchanged", () => {
    const home = path.join(tmpdir(), "hana-isolated", "测试");
    expect(resolveDevWebEnvironment({ HANA_HOME: home }).HANA_HOME).toBe(home);
  });

  it("normalizes server-info into the client config injected into Vite", () => {
    const serverInfo = normalizeServerInfoForDevWeb({
      port: 4567,
      token: "dev-token",
    });

    expect(buildDevWebClientConfig(serverInfo, { clientPort: 5173 })).toEqual({
      serverPort: "5173",
      apiBaseUrl: "http://127.0.0.1:5173",
    });
  });

  it("rejects incomplete server-info instead of guessing a browser connection", () => {
    expect(() => normalizeServerInfoForDevWeb({ port: 4567 }))
      .toThrow("server-info token is required for dev-web");
    expect(() => normalizeServerInfoForDevWeb({ token: "dev-token" }))
      .toThrow("server-info port is required for dev-web");
  });

  it("builds the local browser URL without leaking the owner token into the address bar", () => {
    expect(buildDevWebPreviewUrl({ host: "127.0.0.1", port: 5173 }))
      .toBe("http://127.0.0.1:5173/index.html");
  });

  it("resolves the Vite CLI through node_modules .bin instead of package exports", () => {
    expect(resolveViteCommand("/repo", { platform: "darwin" }))
      .toBe("/repo/node_modules/.bin/vite");
    expect(resolveViteCommand("C:\\repo", { platform: "win32" }))
      .toBe("C:\\repo\\node_modules\\.bin\\vite.cmd");
  });
});
