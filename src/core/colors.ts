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

/** Stable color for an agent name (same name → same color, forever). */
export function agentColor(name: string): AgentColor {
  const slot = mix(fnv1a(name) + SALT) % AGENT_PALETTE.length;
  return { slot, ...AGENT_PALETTE[slot]! };
}

/** Wrap text in an xterm-256 foreground color (reset afterwards). */
export function ansiColorize(text: string, color: AgentColor): string {
  return `\u001b[38;5;${color.ansi256}m${text}\u001b[0m`;
}

/**
 * Light pastel of the agent color for Terminal.app backgrounds: blended
 * toward white so dark text on the default profile stays readable, with
 * enough hue left to tell windows apart at a glance.
 */
export function pastelRgb16(color: AgentColor, whiteness = 0.85): [number, number, number] {
  const r = Number.parseInt(color.hex.slice(1, 3), 16);
  const g = Number.parseInt(color.hex.slice(3, 5), 16);
  const b = Number.parseInt(color.hex.slice(5, 7), 16);
  const blend = (c: number) => Math.round((c * (1 - whiteness) + 255 * whiteness) * 257);
  return [blend(r), blend(g), blend(b)];
}
