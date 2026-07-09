import { randomBytes, randomUUID } from "node:crypto";

export function uuid(): string {
  return randomUUID();
}

/** Opaque session token (for the Authorization header). */
export function sessionToken(): string {
  return "lsk_" + randomBytes(24).toString("base64url");
}

/** Readable slug from free text (e.g. objective → agent name). */
export function slugify(text: string, max = 40): string {
  const base = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return base || "agent";
}

export function nowIso(): string {
  return new Date().toISOString();
}
