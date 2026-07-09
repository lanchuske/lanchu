import { createHmac } from "node:crypto";
import { bus } from "../core/events.js";
import * as store from "../core/store.js";
import type { LanchuEvent } from "../core/types.js";
import type { Webhook } from "../core/store.js";

/**
 * Outbound webhooks: POST each event to subscribed URLs, signed with
 * HMAC-SHA256 in X-Lanchu-Signature. At-least-once with a small backoff.
 */
async function deliver(hook: Webhook, ev: LanchuEvent, attempt = 1): Promise<void> {
  const bodyStr = JSON.stringify(ev);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-lanchu-event": ev.type,
  };
  if (hook.secret) {
    headers["x-lanchu-signature"] = "sha256=" + createHmac("sha256", hook.secret).update(bodyStr).digest("hex");
  }
  try {
    const r = await fetch(hook.url, { method: "POST", headers, body: bodyStr, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`status ${r.status}`);
  } catch {
    if (attempt < 3) setTimeout(() => void deliver(hook, ev, attempt + 1), attempt * 1000);
  }
}

let started = false;
export function startWebhookDelivery(): void {
  if (started) return;
  started = true;
  bus.onEvent((ev) => {
    for (const hook of store.webhooksForEvent(ev.org_id, ev.type)) void deliver(hook, ev);
  });
}
