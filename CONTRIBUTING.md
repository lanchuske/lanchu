# Contributing to Lanchu

Thanks for your interest in Lanchu! Contributions are welcome — and, in keeping with the
project's spirit, they happen in a **controlled, transparent way**.

## Before you start

1. **Read [`DEFINITION.md`](./DEFINITION.md)** — it explains what Lanchu is and, just as
   importantly, what it deliberately is *not* (it's not an orchestrator, not an OS
   sandbox, not a cloud service). PRs that push against the scope in §3 ("the few things
   we do well") will likely be asked to become a roadmap discussion first.
2. **Open an issue before a large change.** For anything beyond a small fix, start a
   discussion so we agree on the approach before you write code. This keeps effort from
   being wasted and keeps the project focused.

## Ground rules

- **Scope discipline.** Lanchu does few things well. New surface area needs a strong case.
- **Stay local & private.** No feature may phone home or send data off the user's machine
  (see the non-negotiable constraints in `DEFINITION.md` §7).
- **OS-agnostic.** Code must run on macOS, Linux, and Windows. Avoid native modules; use
  `node:sqlite` and the `os`/`path` abstractions.
- **English.** All code, comments, docs, and commit messages are in English.
- **Honesty over hype.** Governance is cooperative and auditable, not a cage — describe it
  that way.

## Development

```bash
npm install
npm run build      # tsc → dist/
npm test           # build + node:test suite
npm run lanchu -- doctor   # environment check
```

- Source is TypeScript under `src/` (strict mode). The data model lives in
  [`SCHEMA.md`](./SCHEMA.md); the tool/resource surface in [`ARCHITECTURE.md`](./ARCHITECTURE.md);
  the CLI in [`CLI.md`](./CLI.md).
- Add or update tests under `test/` for any behavior change. Governance-critical paths
  (scope checks, atomic claim, safe retirement) **must** stay covered.

## Pull requests

1. Fork and create a feature branch.
2. Keep PRs focused and small; one concern per PR.
3. Ensure `npm test` passes and `npm run build` is clean.
4. Describe the change and link the issue. If it touches behavior documented in a `.md`
   spec, update that spec in the same PR.
5. A maintainer reviews and merges. Direct pushes to `main` are reserved for maintainers.

## Reporting bugs & ideas

Use the issue templates. For security-sensitive reports, see
[`SECURITY.md`](./SECURITY.md) — please do **not** open a public issue for vulnerabilities.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
