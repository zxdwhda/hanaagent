const pendingCaptures = new WeakMap();

async function capturePage(contents, nativeImage) {
  try {
    const image = await contents.capturePage();
    if (!image.isEmpty()) return image;
  } catch (error) {
    if (!/display surface not available for capture/i.test(error?.message || "")) throw error;
  }

  // Chromium can capture a parked view even when Electron has no display surface yet.
  const debuggerApi = contents.debugger;
  const ownsAttachment = !debuggerApi.isAttached();
  if (ownsAttachment) debuggerApi.attach();
  try {
    const { data } = await debuggerApi.sendCommand("Page.captureScreenshot", { format: "png", fromSurface: true });
    const image = nativeImage.createFromBuffer(Buffer.from(data || "", "base64"));
    if (image.isEmpty()) throw new Error("Browser page capture returned an empty image.");
    return image;
  } finally {
    if (ownsAttachment && debuggerApi.isAttached()) debuggerApi.detach();
  }
}

async function captureBrowserPage(contents, nativeImage) {
  const pending = pendingCaptures.get(contents);
  if (pending) return pending;
  const capture = capturePage(contents, nativeImage);
  pendingCaptures.set(contents, capture);
  try {
    return await capture;
  } finally {
    pendingCaptures.delete(contents);
  }
}

module.exports = { captureBrowserPage };
