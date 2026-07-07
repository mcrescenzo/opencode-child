# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities privately using [GitHub security advisories](https://github.com/mcrescenzo/opencode-child/security/advisories/new) for this repository. Do not open a public issue for suspected vulnerabilities.

Include as much detail as you can: affected version, a reproduction, and the potential impact. You should receive an initial response within a few days.

## Scope Notes

`opencode-child` spawns local `opencode serve` child processes and grants them HTTP Basic auth over loopback by default. If you find a way to:

- reach a child server from outside loopback without `allowNonLoopback: true` and explicit approval,
- leak a child's generated Basic auth password or other secret material outside the redaction boundaries in tool output, logs, or diagnostics,
- bypass `safe` trust-mode restrictions (env stripping, `--pure`, rejected MCP/plugin/config overrides) without an explicit unsafe-approval flag, or
- escalate from a `safe` or `inherit` child to unintended host access,

that is a security report, not a routine bug.

## Supported Versions

Only the latest published version on npm is supported with security fixes.
