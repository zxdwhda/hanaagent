import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExperienceTools,
  listExperienceDocuments,
  recordEntry,
  rebuildIndex,
} from "../packages/engine/lib/tools/experience.ts";
import { loadLocale } from "../packages/engine/lib/i18n.ts";

function mktemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hana-experience-"));
}

describe("experience tools", () => {
  let tmpDir;

  loadLocale("en");

  afterEach(() => {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      tmpDir = null;
    }
  });

  it("recordEntry rejects path-like categories", () => {
    tmpDir = mktemp();
    const experienceDir = path.join(tmpDir, "experience");
    const indexPath = path.join(tmpDir, "experience.md");

    expect(() => recordEntry(experienceDir, indexPath, "../identity", "bad")).toThrow("invalid experience category");
    expect(fs.existsSync(path.join(tmpDir, "identity.md"))).toBe(false);
  });

  it("stores display title separately from the storage filename", async () => {
    tmpDir = mktemp();
    const tools = createExperienceTools(tmpDir, { isEnabled: () => true });
    const recordTool = tools.find((tool) => tool.name === "record_experience");
    const recallTool = tools.find((tool) => tool.name === "recall_experience");

    const recordResult = await recordTool.execute("call-1", {
      category: "Design Notes",
      content: "Remember to preserve owner session identity.",
    });

    expect(recordResult.details).toEqual({
      category: "Design Notes",
      content: "Remember to preserve owner session identity.",
    });

    const docs = listExperienceDocuments(path.join(tmpDir, "experience"));
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe("Design Notes");
    expect(docs[0].file).not.toBe("Design Notes.md");

    rebuildIndex(path.join(tmpDir, "experience"), path.join(tmpDir, "experience.md"));
    const indexText = fs.readFileSync(path.join(tmpDir, "experience.md"), "utf-8");
    expect(indexText).toContain("# Design Notes");

    const recallResult = await recallTool.execute("call-2", { category: "Design Notes" });
    expect(recallResult.content[0].text).toContain("# Design Notes");
    expect(recallResult.content[0].text).toContain("1. Remember to preserve owner session identity.");
  });

  it("uses the display title of a CRLF document in exact recall and in the live overview", async () => {
    tmpDir = mktemp();
    const experienceDir = path.join(tmpDir, "experience");
    const indexPath = path.join(tmpDir, "experience.md");
    recordEntry(experienceDir, indexPath, "Design Notes", "Preserve the same title across line endings.");
    const { filePath } = listExperienceDocuments(experienceDir)[0];
    const crlf = fs.readFileSync(filePath, "utf8").replaceAll("\n", "\r\n");
    fs.writeFileSync(filePath, crlf);
    fs.writeFileSync(indexPath, "# stale-file-title");
    const recall = createExperienceTools(tmpDir, { isEnabled: () => true })[0];

    const exact = await recall.execute("exact", { category: "Design Notes" });
    expect(exact.content[0].text).toBe("# Design Notes\n\n1. Preserve the same title across line endings.");
    const overview = await recall.execute("overview", {});
    expect(overview.content[0].text).toContain("# Design Notes");
    expect(overview.content[0].text).not.toContain("stale-file-title");
    expect(fs.readFileSync(filePath, "utf8")).toBe(crlf);
  });

  it("discloses omitted preview entries and finds a literal term in the full category body", async () => {
    tmpDir = mktemp();
    const experienceDir = path.join(tmpDir, "experience");
    const indexPath = path.join(tmpDir, "experience.md");
    for (let number = 1; number <= 6; number += 1) {
      recordEntry(experienceDir, indexPath, "Archive Notes", `Archive preservation example ${number}.`);
    }
    recordEntry(experienceDir, indexPath, "Archive Notes", "The import receipt uses DeepLedgerSeal.");
    recordEntry(experienceDir, indexPath, "Other Notes", "The import receipt uses a staging seal.");
    const recall = createExperienceTools(tmpDir, { isEnabled: () => true })[0];

    const overview = await recall.execute("overview", {});
    expect(overview.content[0].text).toContain("2 more entries");
    expect(overview.content[0].text).not.toContain("DeepLedgerSeal");
    const search = await recall.execute("search", { query: "deepledgerseal" });
    expect(search.content[0].text).toContain("Archive Notes");
    expect(search.content[0].text).not.toContain("Other Notes");
    expect(search.content[0].text).not.toContain("The import receipt uses");
    const missing = await recall.execute("missing", { query: "NoSuchReceipt" });
    expect(missing.content[0].text).toContain("No categories match");
    const exact = await recall.execute("exact", { category: "Archive Notes" });
    expect(exact.content[0].text).toContain("7. The import receipt uses DeepLedgerSeal.");
  });

  it("keeps stored content but blocks recall and record while paused", async () => {
    tmpDir = mktemp();
    let enabled = true;
    const tools = createExperienceTools(tmpDir, { isEnabled: () => enabled });
    const recordTool = tools.find((tool) => tool.name === "record_experience");
    const recallTool = tools.find((tool) => tool.name === "recall_experience");

    await recordTool.execute("call-1", {
      category: "writing workflow",
      content: "Keep the source of truth explicit.",
    });
    const indexPath = path.join(tmpDir, "experience.md");
    expect(fs.readFileSync(indexPath, "utf-8")).toContain("writing workflow");

    enabled = false;
    const pausedRecall = await recallTool.execute("call-2", {});
    expect(pausedRecall.content[0].text).toContain("Experience is paused");

    const pausedRecord = await recordTool.execute("call-3", {
      category: "writing workflow",
      content: "This should not be added while paused.",
    });
    expect(pausedRecord.content[0].text).toContain("Experience is paused");
    expect(fs.readFileSync(indexPath, "utf-8")).not.toContain("This should not be added");

    enabled = true;
    const resumedRecall = await recallTool.execute("call-4", { category: "writing workflow" });
    expect(resumedRecall.content[0].text).toContain("Keep the source of truth explicit.");
  });
});
