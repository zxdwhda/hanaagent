import { homedir } from "node:os";
import { join } from "node:path";

export function defaultDevHanaHome() {
  return join(homedir(), ".hanaagent-dev");
}

export function applyDevEnvironment(env = process.env, {
  nodeBin = process.execPath,
} = {}) {
  if (!env.HANA_HOME?.trim()) env.HANA_HOME = defaultDevHanaHome();
  if (!env.HANA_DEV_NODE_BIN?.trim()) env.HANA_DEV_NODE_BIN = nodeBin;
  return env;
}
