# Contributing

## Setup

```sh
bun install
```

npm also works if you prefer it; the tracked `package-lock.json` is canonical for consumers (`npm ci`, `npm install`).

## Tests

```sh
node --test tests/*.test.mjs
```

or

```sh
npm test
```

Run a live local smoke test before proposing a release-affecting change. It starts a disposable child `opencode serve` process and requires the `opencode` binary on `PATH`:

```sh
npm run smoke
```

## Dependency Policy

Avoid adding new runtime dependencies without maintainer review. `@opencode-ai/plugin` is the only declared runtime dependency; proposing another one should come with a clear justification in the PR description, since every added dependency expands this plugin's supply-chain surface for every consumer that installs it.

## Hard Invariants

A contributor must not break these, per this repo's `AGENTS.md` and the plugin family's `AGENTS.md`:

- **Export exactly one factory** from `opencode-child.js`. opencode instantiates every exported function as a plugin factory; a stray extra export causes double instantiation.
- **Splice `output.parts` in place; never reassign it.** `output.parts = [...]` is silently ignored by opencode.
- **Keep module-level state bounded.** Any module-level `Map`/registry keyed by runtime values (session IDs, child IDs, etc.) must evict beyond a fixed limit or be cleaned up via the `dispose` hook — no unbounded accumulation.

## Pull Requests

- Keep changes focused; unrelated formatting or refactors belong in a separate PR.
- Add or update tests for behavior changes under `tests/*.test.mjs`.
- Run `node --test tests/*.test.mjs` and `npm pack --dry-run --json` before opening a PR; both must pass.
- Describe the user-visible effect of the change, not just the mechanics of the diff.
- Do not include machine-specific absolute paths, credentials, or other local runtime state in commits or docs.
