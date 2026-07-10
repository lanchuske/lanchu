#!/usr/bin/env node
// Thin bootstrap: check the Node version BEFORE importing anything that pulls in
// node:sqlite, so users on older Node get a clear message instead of a cryptic crash.
const [major, minor] = process.versions.node.split(".").map((n) => Number.parseInt(n, 10)) as [number, number];
const nodeOk = major > 22 || (major === 22 && minor >= 5);

if (!nodeOk) {
  console.error(`Lanchu needs Node.js 22.5 or newer — it uses the built-in node:sqlite database.`);
  console.error(`You have Node ${process.versions.node}.`);
  console.error(`Upgrade Node (https://nodejs.org, or "nvm install 22"), then run this again.`);
  process.exit(1);
}

// node:sqlite is stable enough for us but still marked experimental, so Node prints an
// ExperimentalWarning on first use. Drop just that one warning; leave everything else intact.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const type = typeof args[0] === "string" ? args[0] : (args[0] as { type?: string })?.type;
  const message = typeof warning === "string" ? warning : warning?.message;
  if (type === "ExperimentalWarning" && /SQLite/i.test(message ?? "")) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;

const { run } = await import("./run.js");
await run();
