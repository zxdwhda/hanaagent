// The Gemini catalog can return resource names (models/<id>), but the
// OpenAI-compatible chat endpoint expects the bare ID on the wire.
export function normalizeGeminiOpenAIModelId(
  payload: { model?: string },
  model: { api?: string; baseUrl?: string; base_url?: string } | null | undefined,
  options?: { requestEndpoint?: { api: string; baseUrl: string } },
) {
  const request = options?.requestEndpoint;
  if ((request?.api ?? model?.api) !== "openai-completions"
    || typeof payload.model !== "string" || !/^models\/[^/]+$/.test(payload.model)) return payload;
  const endpoint = URL.parse(request?.baseUrl ?? (model?.baseUrl || model?.base_url || ""));
  if (endpoint?.hostname !== "generativelanguage.googleapis.com"
    || !/^\/v\d+(?:beta\d*)?\/openai\/?$/.test(endpoint.pathname)) return payload;
  return { ...payload, model: payload.model.slice("models/".length) };
}
