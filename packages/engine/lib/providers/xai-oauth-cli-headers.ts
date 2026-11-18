/**
 * Grok CLI chat-proxy request markers for xai-oauth.
 *
 * cli-chat-proxy.grok.com returns HTTP 426 for missing or outdated versions.
 * Keep this in sync with the published stable @xai-official/grok release.
 */

export const GROK_CLI_CLIENT_VERSION = "1.0.89";
export const GROK_CLI_CLIENT_IDENTIFIER = "hana";

export function buildXaiOauthCliProviderHeaders(): Record<string, string> {
  return {
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-version": GROK_CLI_CLIENT_VERSION,
    "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
  };
}

export function buildXaiOauthCliModelHeaders(modelId: string): Record<string, string> {
  const id = String(modelId || "").trim().toLowerCase().split("/").pop() || "";
  if (!id) return {};
  return { "x-grok-model-override": id };
}
