import { describe, expect, it, vi } from "vitest";
import { captureBrowserPage } from "../apps/desktop/src/shared/browser-page-capture.cjs";

function fixture(attached = false) {
  const image = { isEmpty: () => false };
  const debug = {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => { attached = true; }),
    detach: vi.fn(() => { attached = false; }),
    sendCommand: vi.fn(async () => ({ data: Buffer.from("image").toString("base64") })),
  };
  return {
    image,
    debug,
    contents: { capturePage: vi.fn(async () => image), debugger: debug },
    nativeImage: { createFromBuffer: vi.fn(() => image) },
  };
}

describe("desktop browser page capture", () => {
  it("uses Electron native capture when the surface is ready", async () => {
    const { contents, debug, image, nativeImage } = fixture();
    await expect(captureBrowserPage(contents, nativeImage)).resolves.toBe(image);
    expect(debug.attach).not.toHaveBeenCalled();
  });

  it("shares the hidden-view fallback between simultaneous screenshot requests", async () => {
    const { contents, debug, image, nativeImage } = fixture();
    contents.capturePage.mockRejectedValue(new Error("Current display surface not available for capture"));
    const requests = [captureBrowserPage(contents, nativeImage), captureBrowserPage(contents, nativeImage)];
    await expect(Promise.all(requests)).resolves.toEqual([image, image]);
    expect(contents.capturePage).toHaveBeenCalledOnce();
    expect(debug.attach).toHaveBeenCalledOnce();
    expect(debug.sendCommand).toHaveBeenCalledExactlyOnceWith("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    expect(debug.detach).toHaveBeenCalledOnce();
    expect(nativeImage.createFromBuffer).toHaveBeenCalledWith(Buffer.from("image"));
  });

  it("keeps an existing debugger attached and propagates unrelated native errors", async () => {
    const { contents, debug, image, nativeImage } = fixture(true);
    contents.capturePage.mockResolvedValueOnce({ isEmpty: () => true })
      .mockRejectedValueOnce(new Error("WebContents destroyed"));
    await expect(captureBrowserPage(contents, nativeImage)).resolves.toBe(image);
    await expect(captureBrowserPage(contents, nativeImage)).rejects.toThrow("WebContents destroyed");
    expect(debug.attach).not.toHaveBeenCalled();
    expect(debug.detach).not.toHaveBeenCalled();
    expect(debug.sendCommand).toHaveBeenCalledOnce();
  });

  it("releases a failed fallback so a subsequent capture can retry", async () => {
    const { contents, debug, image, nativeImage } = fixture();
    contents.capturePage.mockResolvedValueOnce({ isEmpty: () => true });
    debug.sendCommand.mockRejectedValueOnce(new Error("Screenshot failed"));
    await expect(captureBrowserPage(contents, nativeImage)).rejects.toThrow("Screenshot failed");
    expect(debug.detach).toHaveBeenCalledOnce();
    await expect(captureBrowserPage(contents, nativeImage)).resolves.toBe(image);
    expect(contents.capturePage).toHaveBeenCalledTimes(2);
  });
});
