/**
 * Helpers for the chat-channel flows (Slack, Teams): a direct database
 * connection for seeding what the local profile cannot reach (Slack's
 * auth.test, Microsoft's token endpoint), and Slack's request signature.
 */
import { createHmac, randomUUID } from "node:crypto";
import { Client as PgClient } from "pg";
import type { FlowContext } from "../core/types";

export async function withDb<T>(ctx: FlowContext, run: (db: PgClient) => Promise<T>): Promise<T> {
  const db = new PgClient({ connectionString: ctx.env.databaseUrl! });
  // A dropped connection must fail the next query, not crash the runner.
  db.on("error", () => {});
  await db.connect();
  try {
    return await run(db);
  } finally {
    await db.end().catch(() => {});
  }
}

/** Slack's v0 request signature over a raw body, with the given signing secret. */
export function slackSigned(secret: string, body: string, contentType: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return {
    raw: true as const,
    headers: { "content-type": contentType, "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
  };
}

/** A Kortix webhook's signature (KRTX-4098): HMAC-SHA256 over the payload, `sha256=<hex>`. */
export function webhookSignature(secret: string, payload: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

/** The headers of a signed Kortix webhook delivery; the signature covers `<timestamp>.<body>`. */
export function signedWebhookHeaders(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
  return {
    "content-type": "application/json",
    "x-kortix-timestamp": String(ts),
    "x-kortix-signature": webhookSignature(secret, `${ts}.${body}`),
    "x-kortix-delivery-id": randomUUID(),
  };
}
