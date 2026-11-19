import { describe, expect, it, vi } from "vitest";

import * as wsProtocol from "../apps/server/ws-protocol.ts";

type ProtocolHelper = (input: unknown) => unknown;

function protocolHelper(name: string) {
  const helper = (wsProtocol as Record<string, unknown>)[name];
  expect(helper).toBeTypeOf("function");
  return helper as ProtocolHelper;
}

describe("ws protocol output", () => {
  it("terminates only the socket with a full output queue", () => {
    const slow = {
      readyState: 1,
      raw: { bufferedAmount: 16 * 1024 * 1024, terminate: vi.fn() },
      send: vi.fn(),
    };
    const healthy = {
      readyState: 1,
      raw: { bufferedAmount: 64, terminate: vi.fn() },
      send: vi.fn(),
    };
    const payload = JSON.stringify({ type: "text_delta", delta: "hello" });

    wsProtocol.wsSendSerialized(slow, payload);
    wsProtocol.wsSendSerialized(healthy, payload);

    expect(slow.raw.terminate).toHaveBeenCalledOnce();
    expect(slow.send).not.toHaveBeenCalled();
    expect(healthy.raw.terminate).not.toHaveBeenCalled();
    expect(healthy.send).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it("closes a full socket without serializing the next message", () => {
    const socket = {
      readyState: 1,
      bufferedAmount: 16 * 1024 * 1024,
      close: vi.fn(),
      send: vi.fn(),
    };
    const toJSON = vi.fn();

    wsProtocol.wsSend(socket, { toJSON });

    expect(socket.close).toHaveBeenCalledExactlyOnceWith(1013, "Output backlog");
    expect(socket.send).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });
});

describe("ws protocol session event builders", () => {
  it("wraps session stream events with routing and replay metadata", () => {
    const build = protocolHelper("createSessionStreamEventWsMessage");

    expect(build({
      sessionPath: "/sessions/a.jsonl",
      sessionId: "sess_ws_1",
      sessionEvent: { type: "text_delta", delta: "hello" },
      streamId: "stream_1",
      seq: 7,
    })).toEqual({
      type: "text_delta",
      delta: "hello",
      sessionPath: "/sessions/a.jsonl",
      sessionId: "sess_ws_1",
      sessionRefVersion: 2,
      streamId: "stream_1",
      seq: 7,
    });
  });

  it("rejects conflicting sessionId fields in session stream events", () => {
    const build = protocolHelper("createSessionStreamEventWsMessage");

    expect(() => build({
      sessionPath: "/sessions/a.jsonl",
      sessionId: "sess_ws_1",
      sessionEvent: { type: "text_delta", delta: "hello", sessionId: "sess_ws_2" },
      streamId: "stream_1",
      seq: 7,
    })).toThrow(/sessionEvent\.sessionId conflicts/);
  });

  it("rejects session stream events without an explicit sessionPath", () => {
    const build = protocolHelper("createSessionStreamEventWsMessage");

    expect(() => build({
      sessionPath: "",
      sessionEvent: { type: "text_delta", delta: "hello" },
      streamId: "stream_1",
      seq: 1,
    })).toThrow(/sessionPath.*non-empty string/);
  });

  it("rejects session stream events without an event type", () => {
    const build = protocolHelper("createSessionStreamEventWsMessage");

    expect(() => build({
      sessionPath: "/sessions/a.jsonl",
      sessionEvent: { delta: "hello" },
      streamId: "stream_1",
      seq: 1,
    })).toThrow(/sessionEvent\.type.*non-empty string/);
  });

  it("rejects session stream events with invalid replay metadata", () => {
    const build = protocolHelper("createSessionStreamEventWsMessage");

    expect(() => build({
      sessionPath: "/sessions/a.jsonl",
      sessionEvent: { type: "text_delta", delta: "hello" },
      streamId: "",
      seq: 1,
    })).toThrow(/streamId.*non-empty string/);

    expect(() => build({
      sessionPath: "/sessions/a.jsonl",
      sessionEvent: { type: "text_delta", delta: "hello" },
      streamId: "stream_1",
      seq: 0,
    })).toThrow(/seq.*positive integer/);
  });

  it("builds stream resume responses and validates replayed event shape", () => {
    const build = protocolHelper("createStreamResumeWsMessage");

    expect(build({
      sessionPath: "/sessions/a.jsonl",
      sessionId: "sess_resume_1",
      streamId: "stream_1",
      sinceSeq: 4,
      nextSeq: 8,
      reset: false,
      truncated: false,
      isStreaming: true,
      runtimeIsStreaming: true,
      events: [{
        seq: 5,
        ts: 123,
        event: { type: "text_delta", delta: "hello" },
      }],
    })).toEqual({
      type: "stream_resume",
      sessionPath: "/sessions/a.jsonl",
      sessionId: "sess_resume_1",
      sessionRefVersion: 2,
      streamId: "stream_1",
      sinceSeq: 4,
      nextSeq: 8,
      reset: false,
      truncated: false,
      isStreaming: true,
      runtimeIsStreaming: true,
      events: [{
        seq: 5,
        ts: 123,
        event: { type: "text_delta", delta: "hello" },
      }],
    });

    expect(() => build({
      sessionPath: "/sessions/a.jsonl",
      streamId: "stream_1",
      sinceSeq: 4,
      nextSeq: 8,
      reset: false,
      truncated: false,
      isStreaming: true,
      events: [{ seq: 5, event: { delta: "missing type" } }],
    })).toThrow(/events\[0\]\.event\.type.*non-empty string/);
  });
});
