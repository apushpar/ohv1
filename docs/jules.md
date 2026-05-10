# Jules (Google) — Adapter Guide

Jules is Google's managed coding agent. This document covers everything needed to use the Jules adapter in the OmniHarness **Python** and **TypeScript** SDKs, including authentication, source setup, event types, and plan approval.

## Prerequisites

1. **API key** — obtain a Jules API key from [jules.google.com](https://jules.google.com).
2. **Connected GitHub repo** — Jules only works with repositories you have connected in the Jules dashboard. Verify which repos are available:

```bash
curl -H "x-goog-api-key: $JULES_API_KEY" \
  https://jules.googleapis.com/v1alpha/sources
```

## Authentication

Jules uses a static API key sent as the `x-goog-api-key` header. Store it in a `.env` file (never commit this):

```
# .env
JULES_API_KEY=your_key_here
```

**Python** — pass via `--env-file`; `source .env` alone is insufficient because `uv run` runs in an isolated environment that does not inherit shell-exported variables:

```bash
uv run --project packages/python --env-file .env python your_script.py
```

**TypeScript** — set the variable before running:

```bash
JULES_API_KEY=your_key_here npx tsx your_script.ts
# or export it:
export JULES_API_KEY=your_key_here && npx tsx your_script.ts
```

Both SDKs also accept the key directly in code:

```python
# Python
client = OmniHarness(keys={"jules": "your_key_here"})
```

```typescript
// TypeScript
const client = new OmniHarness({ providerKeys: { jules: "your_key_here" } });
```

## Quickstart — end-to-end example

### Python

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
            print(f"[{event.data.get('title', '')}]")
        elif event.kind == "status":
            print(f"Session {event.data['value']}")
            break

asyncio.run(main())
```

Run it:

```bash
uv run --project packages/python --env-file .env python quickstart.py
```

### TypeScript

```typescript
import { OmniHarness, parseSource } from "omniharness";

const client = new OmniHarness();

const session = await client.sessions.create("jules", {
  prompt: "Summarize this codebase: what it does, its architecture, and key modules.",
  source: parseSource("github://owner/repo"),
  // branch is optional — if omitted, Jules uses the repo's default branch
});

for await (const event of session.stream()) {
  if (event.kind === "message") {
    console.log(event.data["text"]);
  } else if (event.kind === "tool_activity") {
    const title = (event.data["title"] as string) || "";
    if (title) console.log(`[${title}]`);
  } else if (event.kind === "status") {
    console.log(`Session ${event.data["value"]}`);
    break;
  }
}
```

Run it:

```bash
JULES_API_KEY=your_key npx tsx quickstart.ts
```

## Source configuration

The `source` argument tells Jules which repository to work on.

**Python**

```python
from omniharness import Source

# Repo's default branch (adapter fetches it automatically)
source = Source.parse("github://owner/repo")

# Specific branch
source = Source.parse("github://owner/repo@my-branch")

# Explicit object
source = Source(uri="github://owner/repo", kind="github", branch="my-branch")
```

**TypeScript**

```typescript
import { parseSource } from "omniharness";

// Repo's default branch (adapter fetches it automatically)
const source = parseSource("github://owner/repo");

// Specific branch
const source = parseSource("github://owner/repo@my-branch");

// Explicit object
const source = { uri: "github://owner/repo", kind: "github" as const, branch: "my-branch" };
```

Jules requires a `startingBranch` on every session request. When you omit a branch, the adapter calls `GET /v1alpha/sources/github/{owner}/{repo}` to resolve the repo's default branch before creating the session.

## Event types

All events carry `.kind`, `.data`, `.ts`, `.seq`, and `.raw`. Jules emits these in a typical session:

| Kind | When emitted | Key `data` fields |
|------|-------------|-----------------|
| `provider_event` (`type: "plan_proposed"`) | Jules proposes its execution plan | `steps` — list of step objects; full plan in `raw.planGenerated.plan` |
| `provider_event` (`type: "planApproved"`) | Plan approved (auto or by user) | `raw.planApproved.planId` |
| `message` | Agent sends a text response | `text` — the message string |
| `tool_activity` | Agent completes a work step | `title` — step description; `raw.artifacts` — changesets |
| `provider_event` (`type: "sessionCompleted"`) | Jules signals it is done | `raw.artifacts` — final changeset with suggested commit message |
| `provider_event` (`type: "keep_alive"`) | SDK keepalive (no Jules activity for 30 s) | — |
| `status` | Session reaches a terminal state | `value` — `"completed"`, `"failed"`, or `"cancelled"` |

### Reading `tool_activity` events

Jules `progressUpdated` activities carry a `title` in the raw payload, not `tool`/`summary`:

```python
# Python
elif event.kind == "tool_activity":
    title = (event.raw or {}).get("progressUpdated", {}).get("title", "")
    print(f"Progress: {title}")
    for artifact in (event.raw or {}).get("artifacts", []):
        patch = artifact.get("changeSet", {}).get("gitPatch", {})
        print(f"  base commit: {patch.get('baseCommitId')}")
```

```typescript
// TypeScript
} else if (event.kind === "tool_activity") {
  const raw = event.raw as Record<string, unknown>;
  const pu = raw?.["progressUpdated"] as Record<string, unknown> | undefined;
  console.log(`Progress: ${pu?.["title"] ?? ""}`);
  for (const artifact of (raw?.["artifacts"] as unknown[] | undefined) ?? []) {
    const cs = (artifact as Record<string, unknown>)["changeSet"] as Record<string, unknown> | undefined;
    const patch = cs?.["gitPatch"] as Record<string, unknown> | undefined;
    console.log(`  base commit: ${patch?.["baseCommitId"]}`);
  }
}
```

### Reading plan steps

```python
# Python
elif event.kind == "provider_event" and event.data.get("type") == "plan_proposed":
    plan = event.raw["planGenerated"]["plan"]
    for step in plan.get("steps", []):
        print(f"  - {step['title']}: {step.get('description', '')}")
```

```typescript
// TypeScript
} else if (event.kind === "provider_event" && event.data["type"] === "plan_proposed") {
  const raw = event.raw as Record<string, unknown>;
  const plan = (raw?.["planGenerated"] as Record<string, unknown>)?.["plan"] as Record<string, unknown>;
  for (const step of (plan?.["steps"] as Array<Record<string, unknown>>) ?? []) {
    console.log(`  - ${step["title"]}: ${step["description"] ?? ""}`);
  }
}
```

## Plan approval

By default Jules auto-approves its own plan. To require explicit approval, set `require_plan_approval` in `providerOptions`. The session transitions to `awaiting_input` while waiting.

**Python**

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
        await session.approve_plan()
    elif event.kind == "message":
        print(event.data["text"])
    elif event.kind == "status":
        print("Done:", event.data["value"])
        break
```

**TypeScript**

```typescript
const session = await client.sessions.create("jules", {
  prompt: "Refactor the auth module to use JWT",
  source: parseSource("github://owner/repo@main"),
  providerOptions: { require_plan_approval: true },
});

for await (const event of session.stream()) {
  if (event.kind === "provider_event" && event.data["type"] === "plan_proposed") {
    const raw = event.raw as Record<string, unknown>;
    const plan = (raw?.["planGenerated"] as Record<string, unknown>)?.["plan"] as Record<string, unknown>;
    for (const step of (plan?.["steps"] as Array<Record<string, unknown>>) ?? []) {
      console.log(`  Step: ${step["title"]}`);
    }
    await session.approvePlan();
  } else if (event.kind === "message") {
    console.log(event.data["text"]);
  } else if (event.kind === "status") {
    console.log("Done:", event.data["value"]);
    break;
  }
}
```

## Auto PR mode

**Python**

```python
options=SessionOptions(
    prompt="...",
    source=Source.parse("github://owner/repo@main"),
    provider_options={"auto_create_pr": True},
)
```

**TypeScript**

```typescript
const session = await client.sessions.create("jules", {
  prompt: "...",
  source: parseSource("github://owner/repo@main"),
  providerOptions: { auto_create_pr: true },
});
```

The resulting PR URL is available after the session completes:

```python
# Python
await session.wait()
print(session.pull_request_url)
```

```typescript
// TypeScript
await session.wait();
console.log(session.pullRequestUrl);
```

## Listing and reconnecting sessions

**Python**

```python
# List recent sessions
page = await client.sessions.list(provider="jules", limit=10)
for s in page.sessions:
    print(s.id, s.status, s.created_at)

# Reconnect by session ID
session = await client.sessions.get(provider="jules", session_id="12345678901234567890")
async for event in session.stream():
    ...
```

**TypeScript**

```typescript
// List recent sessions
const page = await client.sessions.list("jules", 10);
for (const s of page.sessions) {
  console.log(s.id, s.status, s.createdAt);
}

// Reconnect by session ID
const session = await client.sessions.get("jules", "12345678901234567890");
for await (const event of session.stream()) {
  // ...
}
```

## sendMessage

Jules only accepts `sendMessage` when the session is in `IN_PROGRESS` state. Calling it while `QUEUED` returns a 404. Poll `refresh()` until `in_progress` before sending:

**Python**

```python
import asyncio

session = await client.sessions.create(...)
# Poll until in_progress
while session.status == "queued":
    await asyncio.sleep(3)
    session = await session.refresh()

await session.send_message("Please also update the README.")
```

**TypeScript**

```typescript
let session = await client.sessions.create("jules", { ... });
// Poll until in_progress
while (session.status === "queued") {
  await new Promise(r => setTimeout(r, 3000));
  session = await session.refresh();
}

await session.sendMessage("Please also update the README.");
```

## Error handling

**Python**

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

**TypeScript**

```typescript
import { ProviderError } from "omniharness";

try {
  const session = await client.sessions.create("jules", { ... });
} catch (err) {
  if (err instanceof ProviderError) {
    if (err.kind === "auth") console.error("Invalid or missing JULES_API_KEY");
    else if (err.kind === "not_found") console.error("Repo not connected to Jules");
    else if (err.kind === "rate_limit") console.error(`Rate limited, retry after ${err.retryAfter}s`);
    else console.error(`Provider error (${err.kind}): ${err.message}`);
  }
}
```

## Known Jules API behaviours

These quirks affect both the Python and TypeScript adapters, which handle them transparently:

- **`GET /activities` returns 404 while QUEUED** — Jules does not expose the activities endpoint until the session starts executing. The adapter treats this as an empty list and keeps polling.
- **Session field is `state`, not `status`** — the Jules API uses `state` on session objects; the adapter normalises it to `status` in the SDK types.
- **Activity type detected by field presence** — Jules activities do not have a `kind` field; the type is determined by which payload field is present (`agentMessaged`, `progressUpdated`, `planGenerated`, `userMessaged`, etc.).
- **Source name format** — Jules expects `sources/github/{owner}/{repo}` (slash-separated). The adapter constructs this automatically.
- **`sendMessage` requires `IN_PROGRESS` state** — calling it while the session is `QUEUED` returns 404. See the `sendMessage` section above for the polling pattern.
- **Cancelled sessions are deleted** — after `cancel()`, a `GET` on the session returns 404. The adapter surfaces this as a `ProviderError` with `kind: "not_found"`.
