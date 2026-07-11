/**
 * One visual identity per agent across terminal, panel and tile: a color
 * derived deterministically from the agent's name, so it survives respawns
 * and every surface agrees without coordination.
 *
 * The palette is colorblind-friendly (Okabe–Ito plus two extras, ~10
 * distinguishable hues); beyond 10 agents the hues cycle.
 *
 * KEEP IN SYNC with the mirrored palette/hash in src/server/panel.ts
 * (the panel computes the same color client-side from the agent name).
 */

export interface AgentColor {
  /** Palette slot (0-based). */
  slot: number;
  /** Human name of the hue (for notes/debugging). */
  name: string;
  /** #rrggbb, used by the panel chip and Terminal.app tint. */
  hex: string;
  /** Nearest xterm-256 index, used for ANSI output (statusline, tile roster). */
  ansi256: number;
}

export const AGENT_PALETTE: readonly Omit<AgentColor, "slot">[] = [
  { name: "orange", hex: "#e69f00", ansi256: 214 },
  { name: "sky blue", hex: "#56b4e9", ansi256: 81 },
  { name: "green", hex: "#009e73", ansi256: 36 },
  { name: "yellow", hex: "#f0e442", ansi256: 221 },
  { name: "blue", hex: "#0072b2", ansi256: 32 },
  { name: "vermillion", hex: "#d55e00", ansi256: 166 },
  { name: "pink", hex: "#cc79a7", ansi256: 175 },
  { name: "purple", hex: "#9467bd", ansi256: 140 },
  { name: "teal", hex: "#17becf", ansi256: 44 },
  { name: "gray", hex: "#999999", ansi256: 246 },
];

/** FNV-1a 32-bit — tiny, stable, and easy to mirror in the panel's JS. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * murmur3-style finalizer for avalanche, plus a fixed salt chosen so the
 * common agent/role names (product, builder, qa, frontend, backend, docs…)
 * land on distinct hues. Different names CAN still share a hue — with 10
 * slots that's unavoidable; the palette simply cycles for bigger teams.
 */
const SALT = 1984;
function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Hash-preferred color for an agent name. This is the FALLBACK path (offline
 * statusline, names not in the org roster): close names can collide here.
 * Durable agents get a persisted, per-org de-collided slot at creation
 * (store.ensureColorSlots) — prefer that wherever the roster is available.
 */
export function agentColor(name: string): AgentColor {
  return slotColor(preferredSlot(name));
}

/** The slot a name hashes to before any de-collision. */
export function preferredSlot(name: string): number {
  return mix(fnv1a(name) + SALT) % AGENT_PALETTE.length;
}

/** Palette entry for a (possibly persisted) slot; cycles beyond the palette. */
export function slotColor(slot: number): AgentColor {
  const i = ((slot % AGENT_PALETTE.length) + AGENT_PALETTE.length) % AGENT_PALETTE.length;
  return { slot: i, ...AGENT_PALETTE[i]! };
}

/** Wrap text in an xterm-256 foreground color (reset afterwards). */
export function ansiColorize(text: string, color: Pick<AgentColor, "ansi256">): string {
  return `\u001b[38;5;${color.ansi256}m${text}\u001b[0m`;
}

/** 16-bit-per-channel RGB, as AppleScript's Terminal.app colors expect. */
export type Rgb16 = [number, number, number];

/**
 * Blend the agent hue INTO an existing terminal background, not over it: the
 * user's profile stays the base — a dark profile gets a very dark shade of
 * the hue, a light one a light pastel — so the profile's own text contrast
 * survives almost unchanged. Replaces the old blend-toward-white pastel that
 * assumed dark text and made light-on-dark profiles unreadable.
 */
export function tintedBg16(profileBg: Rgb16, color: AgentColor | string, amount = 0.18): Rgb16 {
  const hex = typeof color === "string" ? color : color.hex;
  const hue16 = [
    Number.parseInt(hex.slice(1, 3), 16) * 257,
    Number.parseInt(hex.slice(3, 5), 16) * 257,
    Number.parseInt(hex.slice(5, 7), 16) * 257,
  ];
  return profileBg.map((c, i) => Math.round(c * (1 - amount) + (hue16[i] ?? 0) * amount)) as Rgb16;
}

/** WCAG relative luminance of a 16-bit RGB color. */
function luminance16(rgb: Rgb16): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 65535;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb16;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1..21) between two 16-bit RGB colors. */
export function contrastRatio16(a: Rgb16, b: Rgb16): number {
  const la = luminance16(a);
  const lb = luminance16(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
