/**
 * experience.js — recall_experience / record_experience 工具
 *
 * 经验库采用渐进式披露：
 *   experience.md   — 重建后的索引（分类 + description + 路径）
 *   experience/*.md  — 分类文件（数字列表），recall 有参时返回
 *
 * 索引由 rebuildIndex 自动生成，不手写。
 */

import { Type } from "../pi-sdk/index.ts";
import { t } from "../i18n.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TITLE_META_RE = /^<!--\s*experience-title:\s*([A-Za-z0-9_-]+)\s*-->$/;

// ── 共享存储操作（导出给 extractor 复用）──

/**
 * 重建索引文件 experience.md
 *
 * 扫描 experienceDir/*.md，每个文件：
 *   - 标题行：# {分类名}（{N} 条）
 *   - description：各条目前 ~20 字拼接，分号分隔
 *   - 路径引用：→ experience/{文件名}
 */
function renderExperienceIndex(docs: ReturnType<typeof listExperienceDocuments>) {
  const blocks = [];

  for (const doc of docs) {
    const entries = doc.body
      .split("\n")
      .map((line) => line.trim())
      .filter((l) => /^\d+\.\s/.test(l))
      .map((l) => l.replace(/^\d+\.\s*/, "").trim());

    if (entries.length === 0) continue;

    const snippets: string[] = [];
    let length = 0;
    for (const entry of entries) {
      const snippet = entry.length > 20 ? entry.slice(0, 20) + "…" : entry;
      const nextLength = length + snippet.length + (snippets.length > 0 ? 2 : 0);
      if (nextLength > 120) break;
      snippets.push(snippet);
      length = nextLength;
    }
    const remaining = entries.length - snippets.length;
    const note = remaining > 0 ? "\n" + t("error.expIndexMore", { count: remaining }) : "";

    blocks.push(
      `# ${doc.title}（${entries.length} 条）\n${snippets.join("; ")}${note}\n→ experience/${doc.file}`,
    );
  }

  return blocks.length > 0 ? blocks.join("\n\n") + "\n" : "";
}

export function rebuildIndex(experienceDir, indexPath) {
  const docs = listExperienceDocuments(experienceDir);
  if (docs.length === 0) {
    try { fs.writeFileSync(indexPath, "", "utf-8"); } catch {}
    return;
  }
  fs.writeFileSync(indexPath, renderExperienceIndex(docs), "utf-8");
}

/**
 * 记录一条经验到分类文件，并重建索引
 *
 * @returns {{ added: boolean, reason?: string }}
 */
export function recordEntry(experienceDir, indexPath, category, content) {
  const safeCategory = normalizeExperienceCategory(category);
  // 确保目录存在
  if (!fs.existsSync(experienceDir)) {
    fs.mkdirSync(experienceDir, { recursive: true });
  }

  const existingDoc = findExperienceDocument(experienceDir, safeCategory);
  const filePath = existingDoc?.filePath || path.join(experienceDir, buildExperienceStorageFileName(safeCategory));
  const existing = existingDoc?.body || readFile(filePath);

  // 去重
  if (existing.includes(content)) {
    return { added: false, reason: "duplicate" };
  }

  // 计算下一个编号
  const lines = existing.split("\n").filter((l) => /^\d+\.\s/.test(l.trim()));
  const nextNum = lines.length + 1;
  const newLine = `${nextNum}. ${content}`;

  const updated = existing.trimEnd()
    ? existing.trimEnd() + "\n" + newLine + "\n"
    : newLine + "\n";

  fs.writeFileSync(filePath, serializeExperienceDocument(safeCategory, updated), "utf-8");
  rebuildIndex(experienceDir, indexPath);

  return { added: true };
}

export function syncExperienceCategories(experienceDir, indexPath, categories) {
  fs.mkdirSync(experienceDir, { recursive: true });

  const existingDocs = listExperienceDocuments(experienceDir);
  const existingByTitle: Map<string, { file: string; filePath: string; title: string; body: string }> = new Map(existingDocs.map((doc) => [doc.title, doc]));
  const nextFiles = new Set();

  for (const [rawCategory, rawBody] of categories) {
    const category = normalizeExperienceCategory(rawCategory);
    const body = String(rawBody || "").trim();
    if (!body) continue;

    const existing = existingByTitle.get(category);
    const fileName = existing?.file || buildExperienceStorageFileName(category);
    const filePath = path.join(experienceDir, fileName);
    nextFiles.add(fileName);
    fs.writeFileSync(filePath, serializeExperienceDocument(category, body), "utf-8");
  }

  for (const doc of existingDocs) {
    if (!nextFiles.has(doc.file)) {
      try { fs.unlinkSync(doc.filePath); } catch {}
    }
  }

  rebuildIndex(experienceDir, indexPath);
}

// ── 工具工厂 ──

function isExperienceEnabled(isEnabled) {
  if (typeof isEnabled !== "function") return false;
  try {
    return isEnabled() === true;
  } catch {
    return false;
  }
}

function pausedResult() {
  return {
    content: [{ type: "text", text: t("error.expPaused") }],
    details: { paused: true },
  };
}

/**
 * 创建 recall_experience + record_experience 工具
 * @param {string} agentDir - agent 数据目录
 * @param {object} [opts]
 * @param {() => boolean} [opts.isEnabled] - 当前 agent 是否启用经验能力
 * @returns {import('../pi-sdk/index.ts').ToolDefinition[]}
 */
export function createExperienceTools(agentDir, opts: { isEnabled?: () => boolean } = {}) {
  const experienceDir = path.join(agentDir, "experience");
  const indexPath = path.join(agentDir, "experience.md");
  const { isEnabled } = opts;

  const recallTool = {
    name: "recall_experience",
    label: "Recall Experience",
    description: "Browse the experience library. Without parameters, returns an overview with short previews. Use query to find category names containing an exact word or phrase across their full entries, then use category to read a specific category. When the user asks you to do a concrete task (write code, research, create documents, analyze problems, etc.), check this tool first for relevant experience before starting. Not needed for casual chat, Q&A, or everyday conversation.",
    sessionPermission: {
      resolveInvocation: (params: any = {}) => {
        if (params.category !== undefined && typeof params.category !== "string") return null;
        if (params.query !== undefined && typeof params.query !== "string") return null;
        const category = typeof params.category === "string" ? params.category.trim() : "";
        if (!category) {
          return { action: "read", kind: "read", capability: "recall_experience.read" };
        }
        try {
          const normalized = normalizeExperienceCategory(category);
          return {
            action: "read",
            kind: "read",
            capability: "recall_experience.read",
            target: {
              type: "experience_category",
              id: Buffer.from(normalized, "utf-8").toString("base64url"),
              label: normalized,
            },
          };
        } catch {
          // 无法规范化的分类名仍是本地只读查询：交给 execute 返回"分类未找到"，
          // 权限层不制造与工具本身不同的失败面
          return { action: "read", kind: "read", capability: "recall_experience.read" };
        }
      },
    },
    parameters: Type.Object({
      category: Type.Optional(
        Type.String({ description: "Category name. Omit to get an overview of all categories" }),
      ),
      query: Type.Optional(
        Type.String({ description: "Case-insensitive literal word or phrase to find in full entries. Use without category." }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      if (!isExperienceEnabled(isEnabled)) return pausedResult();

      const category = params.category?.trim();

      if (!category) {
        const docs = listExperienceDocuments(experienceDir);
        const query = params.query?.trim().toLowerCase();
        if (query) {
          const matches = docs.filter((doc) => doc.body.toLowerCase().includes(query));
          return {
            content: [{
              type: "text",
              text: matches.length > 0
                ? matches.map(({ title, file }) => `- ${title} → experience/${file}`).join("\n")
                : t("error.expQueryNoMatches"),
            }],
            details: {},
          };
        }
        // Build the overview from source files so external edits are reflected.
        return {
          content: [{ type: "text", text: renderExperienceIndex(docs) || t("error.expEmpty") }],
          details: {},
        };
      }

      // 返回具体分类
      let doc = null;
      try {
        doc = findExperienceDocument(experienceDir, category);
      } catch {}
      if (!doc || !doc.body.trim()) {
        return {
          content: [
            { type: "text", text: t("error.expCategoryNotFound", { category }) },
          ],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: `# ${doc.title}\n\n${doc.body}` }],
        details: { category: doc.title },
      };
    },
  };

  const recordTool = {
    name: "record_experience",
    label: "Record Experience",
    description: "Record a lesson learned to the experience library. Use when: the user points out a mistake and explains the correct approach, the user shows frustration or repeatedly emphasizes something, you discover an effective method after trying multiple approaches, the user explicitly says 'from now on do/don't do this', or you hit a pitfall during patrol or autonomous work. Each entry should be concise and direct, one sentence.",
    sessionPermission: {
      resolveInvocation: (params: any = {}) => {
        if (typeof params.category !== "string" || typeof params.content !== "string") return null;
        const category = params.category.replace(/^#+\s*/, "").trim();
        if (!category || !params.content.trim()) return null;
        try {
          const normalized = normalizeExperienceCategory(category);
          return {
            action: "record",
            kind: "routine",
            capability: "record_experience.record",
            target: {
              type: "experience_category",
              id: Buffer.from(normalized, "utf-8").toString("base64url"),
              label: normalized,
            },
          };
        } catch {
          return null;
        }
      },
    },
    parameters: Type.Object({
      category: Type.String({
        description: "Category for the experience, a 2-4 word phrase, e.g. 'tool usage', 'search tips', 'response style'",
      }),
      content: Type.String({
        description: "The specific experience content, concise and direct, one sentence",
      }),
    }),
    execute: async (_toolCallId, params) => {
      if (!isExperienceEnabled(isEnabled)) return pausedResult();

      const category = params.category.replace(/^#+\s*/, "").trim();
      const content = params.content.trim();

      if (!category || !content) {
        return {
          content: [{ type: "text", text: t("error.expEmptyInput") }],
          details: {},
        };
      }

      let result;
      try {
        result = recordEntry(experienceDir, indexPath, category, content);
      } catch (err) {
        if (err.message === "invalid experience category") {
          return {
            content: [{ type: "text", text: err.message }],
            details: {},
          };
        }
        throw err;
      }

      if (!result.added) {
        return {
          content: [{ type: "text", text: t("error.expDuplicate") }],
          details: {},
        };
      }

      return {
        content: [
          { type: "text", text: t("error.expRecorded", { category, content }) },
        ],
        details: { category, content },
      };
    },
  };

  return [recallTool, recordTool];
}

// ── 内部工具 ──

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

export function normalizeExperienceCategory(category) {
  const title = String(category ?? "").trim();
  if (!title) throw new Error("invalid experience category");
  if (/[\0\r\n]/.test(title)) throw new Error("invalid experience category");
  if (title === "." || title === "..") throw new Error("invalid experience category");
  if (title.includes("/") || title.includes("\\") || title.includes("..")) {
    throw new Error("invalid experience category");
  }
  if (/^[A-Za-z]:/.test(title)) throw new Error("invalid experience category");
  return title;
}

export function buildExperienceStorageFileName(category) {
  const title = normalizeExperienceCategory(category);
  const stem = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const hash = crypto.createHash("sha256").update(title).digest("hex").slice(0, 10);
  return `${stem || "experience"}-${hash}.md`;
}

function encodeExperienceTitle(title) {
  return Buffer.from(title, "utf-8").toString("base64url");
}

function decodeExperienceTitle(encoded) {
  return Buffer.from(encoded, "base64url").toString("utf-8");
}

function serializeExperienceDocument(title, body) {
  return `<!-- experience-title: ${encodeExperienceTitle(title)} -->\n${body.trimEnd()}\n`;
}

export function parseExperienceDocument(content, fallbackTitle) {
  const lines = content.split(/\r?\n/);
  const metaMatch = lines[0]?.match(TITLE_META_RE);
  if (!metaMatch) {
    return { title: fallbackTitle, body: content.trimEnd() };
  }

  try {
    const title = normalizeExperienceCategory(decodeExperienceTitle(metaMatch[1]));
    return {
      title,
      body: lines.slice(1).join("\n").replace(/^\n+/, "").trimEnd(),
    };
  } catch {
    return { title: fallbackTitle, body: content.trimEnd() };
  }
}

export function listExperienceDocuments(experienceDir) {
  if (!fs.existsSync(experienceDir)) return [];

  let files;
  try {
    files = fs.readdirSync(experienceDir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }

  return files.map((file) => {
    const filePath = path.join(experienceDir, file);
    const fallbackTitle = file.replace(/\.md$/, "");
    const { title, body } = parseExperienceDocument(readFile(filePath), fallbackTitle);
    return { file, filePath, title, body };
  });
}

export function findExperienceDocument(experienceDir, category) {
  const title = normalizeExperienceCategory(category);
  return listExperienceDocuments(experienceDir).find((doc) => doc.title === title) || null;
}
