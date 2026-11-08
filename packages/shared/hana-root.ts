/**
 * Resolve source and bundled runtime resources from the application root.
 * The server bundle supplies HANA_ROOT; source modules live in packages/shared.
 */
import path from "path";
import { fileURLToPath } from "url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const inferredRoot = path.basename(moduleDir) === "bundle"
  ? path.resolve(moduleDir, "..")
  : path.resolve(moduleDir, "..", "..");

/** Root containing package.json, or the materialized server runtime root. */
export const HANA_ROOT = process.env.HANA_ROOT || inferredRoot;

const RESOURCE_PREFIXES = {
  lib: ["packages", "engine", "lib"],
  core: ["packages", "engine", "core"],
  hub: ["packages", "engine", "hub"],
  shared: ["packages", "shared"],
  desktop: ["apps", "desktop"],
  server: ["apps", "server"],
  cli: ["apps", "cli"],
  plugins: ["extensions", "plugins"],
  skills2set: ["extensions", "skills"],
  examples: ["extensions", "examples"],
  config: ["tooling", "config"],
  scripts: ["tooling", "scripts"],
  build: ["tooling", "build"],
  tools: ["tooling", "tools"],
};

/** Resolve a logical product resource inside the source/runtime layout. */
export function resolveRootPath(root, ...segments) {
  const [head, ...tail] = segments;
  const [first, ...nested] = typeof head === "string" ? head.split(/[\\/]+/) : [];
  const prefix = Object.hasOwn(RESOURCE_PREFIXES, first) ? RESOURCE_PREFIXES[first] : undefined;
  return path.join(root, ...(prefix ? [...prefix, ...nested, ...tail] : segments));
}

export function fromRoot(...segments) {
  return resolveRootPath(HANA_ROOT, ...segments);
}

/** Preserve an explicitly supplied product directory when resolving siblings. */
export function productRoot(productDir) {
  const resolved = path.resolve(productDir);
  const engineDir = path.dirname(resolved);
  if (path.basename(resolved) === "lib"
    && path.basename(engineDir) === "engine"
    && path.basename(path.dirname(engineDir)) === "packages") {
    return path.resolve(engineDir, "..", "..");
  }
  return path.dirname(resolved);
}

export function fromProductRoot(productDir, ...segments) {
  return resolveRootPath(productRoot(productDir), ...segments);
}
