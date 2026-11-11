import { describe, expect, mock, test } from "bun:test";

// The runtime catalog (models.dev) carries no entry for subscription
// providers, so the create gate must not depend on it for `antigravity`.
mock.module("../llm-gateway/models/provider-registry", () => ({
  resolveCatalogUpstream: (providerId: string) =>
    providerId === "google"
      ? {
          kind: "openai-compat" as const,
          envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        }
      : null,
}));

const { expectedSecretResourceName } = await import("./secret-resource-name");

describe("expectedSecretResourceName", () => {
  test("a pooled Antigravity resource uses the fixed secret name the connect flow writes", () => {
    expect(expectedSecretResourceName("antigravity")).toBe("ANTIGRAVITY_AUTH_JSON");
  });

  test("a catalog provider uses the catalog's env var", () => {
    expect(expectedSecretResourceName("google")).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
  });

  test("an unknown provider has no expected name, so the create gate rejects it", () => {
    expect(expectedSecretResourceName("not-a-provider")).toBeUndefined();
  });
});
