async function authenticateDeviceServer(baseUrl, credential, fetchImpl) {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("Invalid device server URL");
  }
  if (typeof credential !== "string" || !credential || credential.length > 4096 || /[\r\n]/.test(credential)) {
    throw new Error("Invalid server access key");
  }
  const endpoint = base.href.replace(/\/+$/, "");
  const signal = AbortSignal.timeout(10_000);
  const request = async (path, init) => {
    const response = await fetchImpl(endpoint + path, { ...init, signal, redirect: "error" });
    if (!response.ok) throw new Error(`server connection request failed: ${response.status} ${response.statusText}`);
    return response.json();
  };
  await request("/api/web-auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  return request("/api/server/identity", { headers: { Authorization: `Bearer ${credential}` } });
}

module.exports = { authenticateDeviceServer };
