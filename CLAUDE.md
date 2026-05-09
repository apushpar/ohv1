# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**OmniHarness** is a unified SDK (Python + TypeScript) providing a normalized interface over five managed coding-agent services: Jules (Google), Claude Managed Agents (Anthropic), OpenHands Cloud, Cursor SDK, and Devin (Cognition). Both SDKs expose an identical public API surface.

## Repository layout

```
packages/
  python/     # Python SDK (requires Python 3.11+, uv)
  typescript/ # TypeScript SDK (requires Node 20+, pnpm)
.github/workflows/ci.yml
```

## Commands

### Python (run from `packages/python/`)

```bash
uv sync --all-extras --dev          # install deps
uv run ruff check . && uv run ruff format --check .  # lint
uv run mypy src/                    # type check
uv run pytest -m "not live"         # unit tests (excludes live API tests)
uv run pytest tests/unit/test_retry.py  # single test file
uv run pytest -m live               # live integration tests (requires API keys)
```

### TypeScript (run from `packages/typescript/`)

```bash
pnpm install                        # install deps
pnpm typecheck                      # type check (tsc --noEmit)
pnpm test                           # run vitest
pnpm build                          # build ESM + CJS + .d.ts via tsup
```

## Architecture

### Core abstraction layer

```
OmniHarness (client)
  └── SessionsResource        # CRUD: create, get, list, cancel
        └── SessionHandle     # stateful wrapper around a running session
              ├── stream()    # async iterator of normalized Event objects
              ├── wait()      # blocks until terminal state
              ├── send_message()
              ├── cancel()
              ├── approve_plan()   # Jules only – raises UnsupportedCapability otherwise
              └── send_tool_result()  # Claude MA only
```

`SessionHandle` is returned from `sessions.create()` and wraps the provider adapter + session state. The client does not expose provider-specific objects.

### Provider adapters

Each provider is a separate adapter module in `src/omniharness/providers/` (Python) or `src/providers/` (TypeScript). All implement `BaseProvider` (Protocol in Python, interface in TypeScript). Adding a provider means adding one file and registering it in `_client.py` / `client.ts`.

| Provider | Adapter file | Streaming strategy |
|----------|-------------|-------------------|
| Jules | `_jules_v1alpha` | polling (cursor-based) |
| Claude MA | `_claude_2026_04` | SSE |
| OpenHands | `_openhands_v1` | polling |
| Cursor | `_cursor` / `cursor-1-0` | async iterator (TypeScript-only; raises `ProviderLanguageError` in Python) |
| Devin | `_devin_v3` | polling |

### Streaming

`_streaming.py` / `streaming.ts` implements three strategies that all normalize to the same `Event` type with monotonic sequence numbers:
- **Polling**: exponential backoff (1 s base, 15 s cap), cursor-based pagination, 30 s keepalive timeout
- **SSE**: for Claude MA's native HTTP streaming
- **Async iterator**: for the Cursor SDK wrapper

### Event and type model

`types.py` / `types.ts` defines the full public type surface. Key types:
- **SessionStatus**: `queued | in_progress | awaiting_input | paused | completed | failed | cancelled`
- **EventKind**: `message | tool_activity | requires_input | artifact | status | provider_event`
- **Source**: repo reference (`github://owner/repo@branch`, gitlab, bitbucket, local)
- **ReplayToken**: base64-encoded session state for reconnection after process restart
- **ProviderCapabilities**: boolean flags checked at runtime before calling optional methods

### Error handling

`errors.py` / `errors.ts` maps HTTP status codes → typed exceptions via `classify_http_error()`. `ProviderError` carries `retryable`, `retry_after`, and `http_status`. Optional features that aren't supported on a provider raise `UnsupportedCapability`.

### Extension capabilities

`providers/_extensions.py` / `providers/extensions.ts` defines capability mixin classes (`SupportsPlanApproval`, `SupportsToolResults`, `SupportsFileUpload`). `SessionHandle` checks these at runtime before dispatching optional calls, which keeps the core interface clean.

## Testing conventions

- Python unit tests use **respx** to mock `httpx` at the transport level.
- TypeScript tests use **vitest** with **MSW** (Mock Service Worker) for HTTP interception.
- Live tests (Python) are marked `@pytest.mark.live` and excluded from CI with `-m "not live"`.
- The key unit test patterns are `Source.parse(url)` round-trips and `ReplayToken` encode/decode.

## Key invariants

- Python and TypeScript public APIs must stay interface-compatible — changes to one should mirror the other.
- Provider adapters must not leak provider-specific types into `SessionHandle` or above.
- All I/O is async-first; no blocking calls in the core path.
- mypy strict mode (Python) and TypeScript strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` must pass without suppressions.
