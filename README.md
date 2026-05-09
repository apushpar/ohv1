# OmniHarness

A unified SDK over five managed coding-agent services: Jules (Google), Claude Managed Agents (Anthropic), OpenHands Cloud, Cursor SDK, and Devin (Cognition).

Create a session on any provider, stream six event types, store a replay token to reconnect later.

## Install

**Python**
```bash
pip install omniharness
```

**TypeScript / JavaScript**
```bash
npm install omniharness
```

## Quickstart

### Python (Jules)

```python
import asyncio
from omniharness import OmniHarness, Source
from omniharness.types import SessionOptions

async def main():
    client = OmniHarness()  # reads JULES_API_KEY from environment

    session = await client.sessions.create(
        provider="jules",
        options=SessionOptions(
            prompt="Add unit tests for the auth module",
            source=Source.parse("github://owner/repo"),
        ),
    )

    async for event in session.stream():
        if event.kind == "message":
            print(event.data["text"])
        elif event.kind == "status":
            print("done:", event.data["value"])
            break

asyncio.run(main())
```

> **Note:** pass the API key via `uv run --env-file .env` — `source .env` alone is not sufficient as `uv run` does not inherit shell-exported variables.

### Python (Claude MA)

```python
session = await client.sessions.create(
    provider="claude",
    options=SessionOptions(
        prompt="Add unit tests for the auth module",
        source=Source.parse("github://acme/api@main"),
        provider_options={
            "agent_id": "agt_...",
            "env_id":   "env_...",
        },
    ),
)

async for event in session.stream():
    if event.kind == "message":
        print(event.data["text"])
    elif event.kind == "artifact":
        print("artifact:", event.data["artifact"].url)
    elif event.kind == "status":
        print("done:", event.data["value"])
        break

print(session.pull_request_url)
```

### TypeScript

```typescript
import { OmniHarness } from "omniharness";

const client = new OmniHarness();

const session = await client.sessions.create("claude", {
  prompt: "Add unit tests for the auth module",
  source: { uri: "github://acme/api@main", kind: "github", branch: "main" },
  providerOptions: { agent_id: "agt_...", env_id: "env_..." },
});

for await (const event of session.stream()) {
  if (event.kind === "message") console.log(event.data.text);
  if (event.kind === "status") break;
}
```

## Reconnect after process restart

```python
# Process A — save the token
session = await client.sessions.create(provider="jules", options=SessionOptions(...))
stored_token = str(session.replay_token)   # persist this string

# Process B — reconnect
session = await client.sessions.get(
    provider="jules",
    session_id="ses_01ABC",
    replay_token=stored_token,
)
await session.wait()
```

## Provider guides

- [Jules (Google)](docs/jules.md) — authentication, source setup, event types, plan approval

## Provider matrix

| Provider | Python | TypeScript | Streaming | Plan Approval | Tool Results | File Upload |
|---|---|---|---|---|---|---|
| **Jules** (Google) | ✅ | ✅ | poll | ✅ | ❌ | ❌ |
| **Claude MA** (Anthropic) | ✅ | ✅ | SSE | ❌ | ✅ | ✅ |
| **OpenHands Cloud** | ✅ | ✅ | poll | ❌ | ❌ | ❌ |
| **Cursor SDK** | ❌ stub | ✅ | async iter | ❌ | ❌ | ❌ |
| **Devin** (Cognition) | ✅ | ✅ | poll | ❌ | ❌ | ❌ |

**Language gap:** The Cursor SDK is TypeScript-only. Python callers get `ProviderLanguageError`.

## Environment variables

| Variable | Provider |
|---|---|
| `JULES_API_KEY` | Jules |
| `ANTHROPIC_API_KEY` | Claude MA |
| `OPENHANDS_API_KEY` | OpenHands |
| `CURSOR_API_KEY` | Cursor |
| `DEVIN_API_KEY` | Devin |
| `DEVIN_ORG_ID` | Devin (required) |

## Event types

| Kind | Data fields | Description |
|---|---|---|
| `message` | `{ text }` | Agent narrative output |
| `tool_activity` | `{ tool, summary }` | Tool call + result |
| `requires_input` | `{ question? }` | Agent waiting for input |
| `artifact` | `{ artifact }` | PR, file, screenshot ready |
| `status` | `{ value }` | Terminal or pause transition |
| `provider_event` | `{ type, raw }` | Raw passthrough |

## Extension capabilities

### Plan approval (Jules only)

```python
# Create session with require_plan_approval to pause before execution
session = await client.sessions.create(
    provider="jules",
    options=SessionOptions(
        prompt="Refactor the auth module",
        source=Source.parse("github://owner/repo@main"),
        provider_options={"require_plan_approval": True},
    ),
)

async for event in session.stream():
    if event.kind == "provider_event" and event.data.get("type") == "plan_proposed":
        # Inspect the plan steps before approving
        for step in event.raw["planGenerated"]["plan"].get("steps", []):
            print(f"  - {step['title']}")
        await session.approve_plan()
    elif event.kind == "status":
        break
```

### Custom tool results (Claude MA only)

```python
async for event in session.stream():
    if event.kind == "tool_activity" and event.data.get("custom"):
        result = await my_tool_handler(event.data["tool"], event.raw)
        await session.send_tool_result(event.raw["tool_use_id"], result)
    elif event.kind == "status":
        break
```

### Capability check

```python
caps = client.capabilities("openhands")
print(caps.send_message)    # False
print(caps.cancellation)    # False
```

## Advanced: provider_api_version

`provider_api_version` is an internal compatibility mechanism. Most users should never need it — pin your `omniharness` package version in your lockfile instead.

## License

MIT
