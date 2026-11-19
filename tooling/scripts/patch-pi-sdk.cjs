/**
 * 验证锁定的 Pi SDK，并把 Responses 消息项已声明的 phase 带到正文增量。
 * SDK 升级时需在移除此补丁前验证 text_delta 和 text_end 的相位。
 */

const crypto = require("node:crypto");
const fs = require("fs");
const path = require("path");

// This verifier runs from tooling/scripts in source and a temporary scripts/ copy in server packages.
const sourceRoot = path.resolve(__dirname, "../..");
const root = __dirname === path.join(sourceRoot, "tooling", "scripts")
  ? sourceRoot
  : path.resolve(__dirname, "..");
const sdkRoot = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
const piAiRoot = path.join(root, "node_modules", "@earendil-works", "pi-ai");
const verifiedVersions = new Set(["0.80.3"]);
const verifiedPiAiVersions = new Set(["0.80.3"]);

function fail(message) {
  console.error(`[verify-pi-sdk] ${message}`);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

if (!fs.existsSync(sdkRoot)) {
  console.log("[verify-pi-sdk] SDK not installed, skipping");
  process.exit(0);
}

const pkg = readJson(path.join(sdkRoot, "package.json"));
if (!verifiedVersions.has(pkg.version)) {
  fail(`SDK version ${pkg.version} is not verified. Verified versions: ${[...verifiedVersions].join(", ")}`);
}

if (!fs.existsSync(piAiRoot)) {
  fail("@earendil-works/pi-ai is not installed");
}
const piAiPkg = readJson(path.join(piAiRoot, "package.json"));
if (!verifiedPiAiVersions.has(piAiPkg.version)) {
  fail(`pi-ai version ${piAiPkg.version} is not verified. Verified versions: ${[...verifiedPiAiVersions].join(", ")}`);
}

const sdkIndex = fs.readFileSync(path.join(sdkRoot, "dist", "index.js"), "utf8");
const expectedExportMarkers = [
  "createAgentSession",
  "createReadTool",
  "createWriteTool",
  "createEditTool",
  "createBashTool",
  "createGrepTool",
  "createFindTool",
  "createLsTool",
  "parseSessionEntries",
  "buildSessionContext",
];

for (const marker of expectedExportMarkers) {
  if (!sdkIndex.includes(marker)) {
    fail(`expected SDK export marker not found: ${marker}`);
  }
}

function patchResponsesPhase(packageRoot) {
  const sourcePath = path.join(packageRoot, "dist", "api", "openai-responses-shared.js");
  const originalHash = "20b7552b535da2d0bc0bae21eaa93905fbce500f5aeed24a9ac54d702ff84ede";
  const patchedHash = "ebf6c63c8382eba7c70917b5672ba98b4dbebd3152c42955bb04e29a9cfca4cb";
  const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const source = fs.readFileSync(sourcePath, "utf8");
  const hash = digest(source);
  if (hash === patchedHash) return;
  if (hash !== originalHash) fail(`unrecognized Responses parser: ${path.relative(root, sourcePath)}`);

  const start = '            const block = { type: "text", text: "" };';
  const patched = source.replace(start, [
    start,
    '            if (item.phase === "commentary" || item.phase === "final_answer") {',
    "                block.textSignature = encodeTextSignatureV1(item.id, item.phase);",
    "            }",
  ].join("\n")).replace(
    "                slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);",
    "                slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? parseTextSignature(slot.block.textSignature)?.phase);",
  );
  if (digest(patched) !== patchedHash) fail("Responses phase patch does not match the verified digest");
  const temporaryPath = `${sourcePath}.${process.pid}.patch`;
  try {
    fs.writeFileSync(temporaryPath, patched, { mode: fs.statSync(sourcePath).mode & 0o777, flag: "wx" });
    fs.renameSync(temporaryPath, sourcePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

const piAiCopies = [piAiRoot, ...[
  sdkRoot,
  path.join(root, "node_modules", "@earendil-works", "pi-agent-core"),
].map((packageRoot) => path.join(packageRoot, "node_modules", "@earendil-works", "pi-ai"))];
for (const packageRoot of new Set(piAiCopies.filter((candidate) => fs.existsSync(candidate)).map((candidate) => fs.realpathSync(candidate)))) {
  const { version } = readJson(path.join(packageRoot, "package.json"));
  if (!verifiedPiAiVersions.has(version)) fail(`unverified nested pi-ai version ${version}`);
  patchResponsesPhase(packageRoot);
}

const scanDirs = ["core", "server", "lib", "hub"].map(d => path.join(root, d));
const adapterDir = path.join(root, "packages", "engine", "lib", "pi-sdk");
const importPattern = /(?:from\s+["']@(?:mariozechner|earendil-works)\/(?:pi-ai|pi-coding-agent)|import\s*\(\s*["']@(?:mariozechner|earendil-works)\/(?:pi-ai|pi-coding-agent)|require\s*\(\s*["']@(?:mariozechner|earendil-works)\/(?:pi-ai|pi-coding-agent))/;
const leaks = [];

function scanDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === adapterDir || entry.name === "node_modules") continue;
      scanDir(full);
    } else if (/\.(js|mjs|cjs|ts)$/.test(entry.name)) {
      const content = fs.readFileSync(full, "utf8");
      if (importPattern.test(content)) {
        leaks.push(path.relative(root, full));
      }
    }
  }
}

for (const dir of scanDirs) scanDir(dir);

if (leaks.length > 0) {
  fail(`production files bypass lib/pi-sdk: ${leaks.join(", ")}`);
}

console.log("[verify-pi-sdk] all checks passed");
