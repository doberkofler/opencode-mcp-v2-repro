## Confirmed on v2.0.32 (current release)

This still reproduces on the installed release, not only on the older `1.18.x`
builds in the report. I drove the same V2 path described here:
`POST /api/session` followed by `POST /api/session/{id}/prompt`, with the agent
loop waited to idle through `POST /api/experimental/session/{id}/wait`.

To remove my own MCP server and tool schema from the equation, I used a
dependency-free stdio server with exactly one tool (`example_ping`, no
arguments, returns `"pong"`) and a local OpenAI-compatible provider that records
the outgoing `tools[]` array. The provider calls the tool when it is offered and
otherwise answers `NO_PING_TOOL`, so the result is visible in the transcript as
well as in the captured request.

Reproduction: https://github.com/doberkofler/opencode-mcp-v2-repro

Measured result:

```
opencode --version        -> 2.0.32
GET /api/mcp              -> reproping: connected
MCP tools/list            -> example_ping
provider tools[]          -> edit, glob, grep, question, read, shell, skill,
                             subagent, webfetch, websearch, write, execute
tools containing "ping"   -> none
server name in request    -> absent from system prompt, tools, and Code Mode
assistant reply           -> NO_PING_TOOL
```

The `execute` tool is present. Its Code Mode catalog does not mention the MCP
server either, so the tool is not reachable through that path in this run. The
server is connected and its catalog has been read before the session is
created.

The capture is from a real provider request, not from session metadata. Built-in
tools are present in the same request, which matches your observation that only
the MCP materialization step is missing.

I can contribute this as a regression test if useful. The harness is three
small Node files with no dependencies: MCP server, recording provider, and a
driver that starts `opencode serve --standalone`, calls the V2 endpoints, and
asserts on the captured `tools[]`. It should map naturally onto a test around
`ToolRegistry.materialize()`; tell me where you want it and I will open a PR.

Happy to also re-run it against a candidate build and post the before/after
request capture here.
