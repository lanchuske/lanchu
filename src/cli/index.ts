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

const { run } = await import("./run.js");
await run();
