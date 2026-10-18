# OpenCode MCP tool-exposure reproduction

Minimal, dependency-free reproduction for
[OpenCode issue #45333](https://github.com/anomalyco/opencode/issues/45333):
the V2 session runner reports an MCP server as connected but never gives its
tools to the model.

Observed on **OpenCode v2.0.32** (installed release) on macOS, Node 26.

## Result

```
verdict: reproduced
GET /api/mcp              -> reproping: connected
MCP tools/list            -> example_ping
provider request tools[]  -> built-in tools + execute only
MCP server name in request -> absent (system prompt, tools, Code Mode catalog)
assistant reply           -> NO_PING_TOOL
```

The MCP tool is not exposed through either the native tool list or the Code Mode
catalog: the server name appears nowhere in the outgoing request.

## Requirements

- `opencode` on `PATH` (the affected build; recorded as v2.0.32)
- Node.js 22 or newer
- No npm dependencies

Set `OPENCODE_BIN=/path/to/opencode` to test a different binary.

## Run

```sh
node repro.mjs
```

The harness exits `0` when it completes. Read `verdict` in the output:

| Verdict | Meaning |
| --- | --- |
| `reproduced` | MCP server connected and exposed `example_ping`, but no provider request advertised it. |
| `not-reproduced` | A provider request advertised a tool whose name contains `ping`. |
| `inconclusive` | Harness or environment failure; see `reasons`. |

Exit code `2` means the harness itself failed.

Add `--keep` to retain the disposable workspace. The workspace path is printed
in the summary.

## What the harness starts

1. `mcp-server.mjs`: a raw stdio MCP server exposing one tool, `example_ping`,
   that returns `pong`. It writes a marker file after serving `tools/list`, so
   the harness can prove the catalog was loaded rather than merely connected.
2. `mock-provider.mjs`: an OpenAI-compatible provider. It records every
   request's `tools[]` names, message roles, and whether the MCP server is named
   anywhere in the messages. It calls the ping tool when present; otherwise it
   answers `NO_PING_TOOL`.
3. `opencode serve --standalone` in a throwaway workspace whose
   `opencode.jsonc` registers both processes.
4. The harness drives the V2 API from the issue:
   `POST /api/session`, `POST /api/session/{id}/prompt`, then
   `POST /api/experimental/session/{id}/wait`.

Each run uses isolated `XDG_*` directories and `OPENCODE_DB`, so it does not
touch global OpenCode configuration or session data.

## Evidence

`evidence/` is rewritten on every run:

| File | Content |
| --- | --- |
| `summary.json` | Verdict, version, MCP state, captured requests, reasons |
| `requests.jsonl` | One record per provider request |
| `provider-bodies.jsonl` | Full provider request bodies |
| `session-messages.json` | V2 session transcript |
| `opencode-server.log` | OpenCode server stdout/stderr |
| `provider-requests.jsonl` | Raw mock-provider capture |

The committed evidence is from the run described above.

## Notes

- The mock model has `capabilities.tools: true`; the request does include all
  built-in tools, so tool transmission itself works.
- The MCP server connects asynchronously. The harness waits for both the
  `connected` state and the `tools/list` marker before creating the session.
- A short settle delay after writing `opencode.jsonc` is required; without it,
  the installed build sometimes launches before project configuration is
  discoverable.
- In v2.0.32, an unknown `mcp.servers.*.codemode` key caused the whole project
  configuration to be ignored silently. The harness therefore omits it.
- This is a report-only reproduction. It does not patch OpenCode.

## Posting upstream

`issue-comment.md` contains a ready-to-post comment with the measured results
and an offer to contribute a regression test.
