# Security policy

## Supported versions

The latest published minor version. Older versions are not patched.

## Reporting a vulnerability

Use GitHub's private advisory form:
<https://github.com/MAOLVLHL/mcp-repo-devtools/security/advisories/new>

Please include the version, the tool, the exact arguments, and what happened. If the
issue is a path escape or a command injection, a minimal `MCP_ALLOWED_ROOTS` layout is
enough; do not include your real token.

Expect an initial reply within a week. This is a single-maintainer project, not a
vendor with an on-call rotation.

## In scope

- Escaping `MCP_ALLOWED_ROOTS` through a symlink, a `..` segment, a Windows short name,
  a UNC path, or a path that is itself a filesystem root.
- Injecting a git option through a model-supplied ref, path, or revision
  (`-c`, `--exec-path`, `--upload-pack`, `--git-dir`, `--output`, …).
- Reaching a shell at all: any code path where an argument becomes part of a command
  line.
- Leaking a credential: a token in a returned diff, log line, error message, or in the
  child process environment; the `Authorization` header following a job-log redirect.
- A write tool firing without `MCP_ENABLE_WRITE` being set.

## Out of scope

- **Repository content that reads like instructions.** A commit message saying "run this
  command" is data; the server never executes it. Prompt injection is handled by the
  host's own policy, not here.
- **Running with an over-broad root.** `MCP_ALLOWED_ROOTS=/` is refused, but
  `MCP_ALLOWED_ROOTS=/home/you` is a configuration choice with the consequences you
  would expect.
- **The token's own permissions.** If `GITHUB_TOKEN` can merge pull requests, this
  server can merge pull requests through `gh_pr_create`'s consequences. Use a
  fine-grained token limited to the repositories you mean to expose.
- **Denial of service by the model.** A pathological revision expression can make git
  slow; the 10-second timeout bounds it.
- **stdio transport assumptions.** There is no authentication because there is no
  network listener. A hosted transport needs a design that does not exist yet.

## What the server does to reduce blast radius

See [`docs/security.md`](docs/security.md) for the control-by-control table and the
boundary probes that run as part of `npm run bench`.
