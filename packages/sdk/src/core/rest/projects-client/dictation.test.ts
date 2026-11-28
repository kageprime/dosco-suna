import { afterEach, beforeEach, expect, test } from "bun:test";
import { configureKortix } from "../../http/config";
import { ApiError } from "../../http/api-client";
import { dictationFileName, getDictationInfo, transcribeDictation } from "./dictation";

const projectId = "11111111-1111-4111-8111-111111111111";
const originalFetch = globalThis.fetch;

beforeEach(() => {
  configureKortix({ backendUrl: "https://api.test/v1", getToken: async () => "test-token" });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("reads whether dictation is available and its price", async () => {
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe(`https://api.test/v1/workspaces/${projectId}/dictation`);
    expect(init?.method ?? "GET").toBe("GET");
    return Response.json({ available: true, credits_per_minute: 1, max_seconds: 600, max_bytes: 26214400 });
  }) as typeof fetch;
  expect(await getDictationInfo(projectId)).toEqual({
    available: true,
    credits_per_minute: 1,
    max_seconds: 600,
    max_bytes: 26214400,
  });
});

test("sends a recorded clip as multipart `audio` with its surface, and returns the text", async () => {
  let seen: FormData | undefined;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe(`https://api.test/v1/workspaces/${projectId}/dictation`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
    seen = init?.body as FormData;
    return Response.json({ text: "open the session", seconds: 4, credits: 0.0667 });
  }) as typeof fetch;
  const clip = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: "audio/webm;codecs=opus" });
  const result = await transcribeDictation(projectId, clip, { surface: "desktop" });
  expect(result).toEqual({ text: "open the session", seconds: 4, credits: 0.0667 });
  const audio = seen?.get("audio") as File;
  expect(audio.name).toBe("dictation.webm");
  expect(audio.size).toBe(4);
  expect(seen?.get("surface")).toBe("desktop");
});

test("names a clip after its container, so the server reads it whatever the host's type", () => {
  expect(dictationFileName("audio/webm;codecs=opus")).toBe("dictation.webm");
  expect(dictationFileName("audio/mp4")).toBe("dictation.m4a");
  expect(dictationFileName("audio/ogg")).toBe("dictation.ogg");
  expect(dictationFileName("audio/wav")).toBe("dictation.wav");
  expect(dictationFileName("")).toBe("dictation.webm");
});

test("a refused clip throws an ApiError that carries the server's code", async () => {
  globalThis.fetch = (async () =>
    Response.json(
      { error: "Out of credits.", message: "Out of credits.", code: "insufficient_credits", billing_state: "out_of_credits" },
      { status: 402 },
    )) as unknown as typeof fetch;
  const error = await transcribeDictation(projectId, new Blob([new Uint8Array([1])], { type: "audio/webm" })).catch((e) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(402);
  expect((error as ApiError).code).toBe("insufficient_credits");
});
