# Releasing opencode-child

Publishing is a human-approved step. Do not publish from an automated remediation run unless the maintainer explicitly asks for it.

## Version And Notes

1. Choose the SemVer bump from the user-visible change: patch for compatible fixes, minor for compatible feature additions, major for breaking changes.
2. Update `package.json` version in the same commit as the release notes.
3. Update `CHANGELOG.md` if one exists, or include equivalent release notes in the PR/release description before tagging.
4. Use an annotated git tag named `vX.Y.Z` for the exact package version after all gates pass.

## Required Gates

Run these from the package root before tagging or publishing:

```sh
npm test
npm run smoke
npm pack --dry-run --json
```

The public CI workflow runs the deterministic part of this gate (`npm ci --ignore-scripts --no-audit --no-fund`, `npm test`, and `npm pack --dry-run --json`) on Node `20.11.0` and `22.x` for pushes and pull requests. `npm run smoke` is intentionally manual because it starts live `opencode serve` child processes and requires an `opencode` binary on `PATH`.

For lockfile/package-manager verification, run a clean npm install from the tracked lockfile in a disposable directory. Use `--ignore-scripts` when you only need to prove dependency resolution, because the transitive optional `msgpackr-extract` package declares a native install hook:

```sh
npm ci --ignore-scripts --no-audit --no-fund
```

Inspect the `npm pack --dry-run --json` output. The package should contain only the runtime entrypoint, `src/`, `scripts/`, README, release docs, license, and package metadata.

Optional but recommended before the final publish:

```sh
npm publish --dry-run --access public
```

## Publish

1. Confirm the worktree is clean and the release commit/tag are pushed.
2. Confirm npm auth and package ownership are correct with `npm whoami` and `npm owner ls @mcrescenzo/opencode-child`.
3. Publish the exact tagged commit:

```sh
npm publish --access public
```

4. Verify the published version and dist tag:

```sh
npm view @mcrescenzo/opencode-child version dist-tags
```

## Rollback

Do not rely on unpublish as the normal rollback path; npm unpublish is policy-restricted and may not be available for a public package version.

Preferred rollback actions:

1. Move the `latest` dist tag back to the last good version if consumers need immediate relief.
2. Deprecate the bad version with a short explanation.
3. Publish a fixed patch version from a new clean commit and tag.

Only attempt unpublish with maintainer approval after checking the current npm policy for the exact package/version state.
