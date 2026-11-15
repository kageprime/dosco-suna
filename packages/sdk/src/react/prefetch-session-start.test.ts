import { describe, expect, mock, test } from "bun:test";

import type { QueryClient } from "@tanstack/react-query";

import { sessionStartKey } from "../core/rest/projects-client";
import { prefetchSessionStart } from "./prefetch-session-start";

describe("prefetchSessionStart", () => {
  test("returns the underlying prefetch promise so callers can sequence on /start settling", async () => {
    // apps/web defers its sessions-list invalidate until this settles: the
    // list refetch must not race the warm-marker drop `/start` performs
    // (use-new-project-session.ts). A void return forced hosts to guess.
    const sentinel = Promise.resolve();
    const prefetchQuery = mock(() => sentinel);
    const queryClient = { prefetchQuery } as unknown as QueryClient;

    const result = prefetchSessionStart(queryClient, "p1", "s1");

    expect(result).toBe(sentinel);
    expect(prefetchQuery).toHaveBeenCalledTimes(1);
    const args = prefetchQuery.mock.calls[0] as unknown as [
      { queryKey: unknown; staleTime: number },
    ];
    expect(args[0].queryKey).toEqual(sessionStartKey("p1", "s1"));
    // Finding 16: a prefetch answer read this instant is not read again.
    expect(args[0].staleTime).toBe(2_000);
  });
});

// Finding 16: the prefetch sent a one-shot `/start` that answered in ~0.5 s, so
// the page's mount sent its own long-poll right after it: two `/start` before
// any box change. The prefetch long-polls like the page, and the mount joins it.
describe("prefetchSessionStart and the page's /start", () => {
  test("the prefetch long-polls; the page's read of the same key while it is in flight sends no second /start", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    const { configureKortix } = await import("../core/http/config");
    configureKortix({ backendUrl: "http://test.local", getToken: async () => "tok" });
    const urls: string[] = [];
    let answer: (value: Response) => void = () => {};
    globalThis.fetch = (async (input: unknown) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return new Promise<Response>((resolve) => (answer = resolve));
    }) as unknown as typeof fetch;
    const queryClient = new QueryClient();

    const prefetch = prefetchSessionStart(queryClient, "p1", "s_new");
    const page = queryClient.fetchQuery({
      queryKey: sessionStartKey("p1", "s_new"),
      queryFn: () => Promise.reject(new Error("the page must reuse the prefetch")),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(urls.filter((url) => url.includes("/start"))).toHaveLength(1);
    expect(urls[0]).toContain("wait_ms=15000");

    answer(Response.json({ stage: "ready" }));
    await prefetch;
    expect((await page) as unknown).toEqual(expect.objectContaining({ stage: "ready" }));
  });
});
