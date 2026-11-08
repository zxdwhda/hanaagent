import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { describe, expect, it } from "vitest";

const read = (name: string) => fs.readFileSync(path.join(process.cwd(), ".github/workflows", name), "utf8");
describe("independent source publication", () => {
  it("does not publish on tags or mirror to the author account", () => {
    const text = read("build.yml");
    const workflow = YAML.load(text) as any;
    expect(workflow.on.push).toBeUndefined();
    expect(workflow.jobs["renderer-box"].if).toContain("HANA_ENABLE_PUBLIC_RELEASES");
    expect(text).not.toContain("mirror-atomgit:");
    expect(text).not.toContain("ATOMGIT_OWNER: liliMozi");
    const train = YAML.load(read("publish-train.yml")) as any;
    expect(train.jobs["publish-train"].if).toContain("HANA_ENABLE_PUBLIC_RELEASES");
  });
});
