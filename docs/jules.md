# Jules (Google) — Python Adapter

Jules is Google's managed coding agent. This document covers everything needed to use the Jules adapter in the OmniHarness Python SDK, including authentication, source setup, event types, and plan approval.

## Prerequisites

1. **API key** — obtain a Jules API key from [jules.google.com](https://jules.google.com).
2. **Connected GitHub repo** — Jules only works with repositories you have connected in the Jules dashboard. You can verify which repos are available:

```bash
curl -H "x-goog-api-key: $JULES_API_KEY" \
  https://jules.googleapis.com/v1alpha/sources
```

## Authentication

Jules uses a static API key passed as `x-goog-api-key`. Store it in a `.env` file (never commit this):

```
# .env
JULES_API_KEY=your_key_here
```

Pass it to `uv run` via `--env-file` — `source .env` alone is not enough because `uv run` runs in an isolated environment that does not inherit shell-exported variables:

```bash
uv run --project packages/python --env-file .env python your_script.py
```

Alternatively, pass the key explicitly in code:

```python
client = OmniHarness(keys={"jules": "your_key_here"})
```

## Quickstart — end-to-end example

```python
import asyncio
from omniharness import OmniHarness, Source
from omniharness.types import SessionOptions

async def main():
    client = OmniHarness()  # reads JULES_API_KEY from environment

    session = await client.sessions.create(
        provider="jules",
        options=SessionOptions(
            prompt="Summarize this codebase: what it does, its architecture, and key modules.",
            source=Source.parse("github://owner/repo"),
            # branch is optional — if omitted, Jules uses the repo's default branch
        ),
    )

    async for event in session.stream():
        if event.kind == "message":
            print(event.data["text"])
        elif event.kind == "tool_activity":
            print(f"[{event.data['title']}]")
        elif event.kind == "status":
            print(f"Session {event.data['value']}")
            break

asyncio.run(main())
```

Run it:

```bash
uv run --project packages/python --env-file .env python quickstart.py
```

## Source configuration

The `source` argument tells Jules which repository to work on.

```python
# Repo's default branch (adapter fetches it automatically)
source=Source.parse("github://owner/repo")

# Specific branch
source=Source.parse("github://owner/repo@my-branch")

# Explicit object form
from omniharness.types import Source
source=Source(uri="github://owner/repo", kind="github", branch="my-branch")
```

Jules requires a branch on every request. When you omit one, the adapter calls `GET /v1alpha/sources/github/{owner}/{repo}` to resolve the default branch before creating the session.

## Event types

All events are `Event` objects with `.kind`, `.data`, `.ts`, `.seq`, and `.raw` attributes. Jules emits these kinds in a typical session:

| Kind | When emitted | Key data fields |
|------|-------------|-----------------|
| `provider_event` (type `"plan_proposed"`) | Jules proposes its execution plan | `data["steps"]` — list of step dicts; full plan in `event.raw["planGenerated"]["plan"]` |
| `provider_event` (type `"planApproved"`) | Plan approved (auto or by user) | `event.raw["planApproved"]["planId"]` |
| `message` | Agent sends a text response | `data["text"]` — the message string |
| `tool_activity` | Agent completes a work step | `data["title"]` — step description; `event.raw["artifacts"]` — changesets |
| `provider_event` (type `"sessionCompleted"`) | Jules signals it is done | `event.raw["artifacts"]` — final changeset with suggested commit message |
| `provider_event` (type `"keep_alive"`) | SDK keepalive (no Jules activity for 30 s) | — |
| `status` | Session reaches terminal state | `data["value"]` — `"completed"`, `"failed"`, or `"cancelled"` |

### Reading `tool_activity` events

Jules `progressUpdated` activities carry a `title` in the raw payload, not `tool`/`summary`:

```python
elif event.kind == "tool_activity":
    title = event.raw["progressUpdated"].get("title", "")
    print(f"Progress: {title}")
    # check for changesets
    for artifact in event.raw.get("artifacts", []):
        cs = artifact.get("changeSet", {})
        patch = cs.get("gitPatch", {})
        print(f"  base commit: {patch.get('baseCommitId')}")
```

### Reading `provider_event` plan steps

```python
elif event.kind == "provider_event" and event.data.get("type") == "plan_proposed":
    plan = event.raw["planGenerated"]["plan"]
    for step in plan.get("steps", []):
        print(f"  - {step['title']}: {step.get('description', '')}")
```

## Plan approval

By default Jules auto-approves its own plan. To require explicit approval, set `require_plan_approval` in `provider_options`. The session transitions to `awaiting_input` state while waiting.

```python
session = await client.sessions.create(
    provider="jules",
    options=SessionOptions(
        prompt="Refactor the auth module to use JWT",
        source=Source.parse("github://owner/repo@main"),
        provider_options={"require_plan_approval": True},
    ),
)

async for event in session.stream():
    if event.kind == "provider_event" and event.data.get("type") == "plan_proposed":
        plan = event.raw["planGenerated"]["plan"]
        for step in plan.get("steps", []):
            print(f"  Step: {step['title']}")
        # Approve after reviewing
        await session.approve_plan()
    elif event.kind == "message":
        print(event.data["text"])
    elif event.kind == "status":
        print("Done:", event.data["value"])
        break
```

## Auto PR mode

To have Jules automatically create a pull request when it finishes:

```python
options=SessionOptions(
    prompt="...",
    source=Source.parse("github://owner/repo@main"),
    provider_options={"auto_create_pr": True},
)
```

The resulting PR URL appears as an `Artifact` on the session once completed:

```python
await session.wait()
print(session.pull_request_url)
```

## Listing and reconnecting sessions

```python
# List recent sessions
page = await client.sessions.list(provider="jules", limit=10)
for s in page.sessions:
    print(s.id, s.status, s.created_at)

# Reconnect to an existing session by ID
session = await client.sessions.get(provider="jules", session_id="12345678901234567890")
async for event in session.stream():
    ...
```

## Error handling

```python
from omniharness.errors import ProviderError

try:
    session = await client.sessions.create(...)
except ProviderError as e:
    if e.kind == "auth":
        print("Invalid or missing JULES_API_KEY")
    elif e.kind == "not_found":
        print("Repo not connected to Jules — check GET /v1alpha/sources")
    elif e.kind == "rate_limit":
        print(f"Rate limited, retry after {e.retry_after}s")
    else:
        print(f"Provider error ({e.kind}): {e}")
```

## Known Jules API behaviours

- `GET /v1alpha/sessions/{id}/activities` returns **404** while the session is in `QUEUED` state (not yet started). The adapter handles this transparently by treating it as an empty activity list and continuing to poll.
- The session object uses the field name **`state`** (not `status`) for the current state.
- Activity type is indicated by **which field is present** in the activity object (`agentMessaged`, `progressUpdated`, `planGenerated`, etc.) — there is no explicit `kind` field.
- The source name format Jules expects is `sources/github/{owner}/{repo}` (slash-separated), not `sources/github-{owner}-{repo}`.
