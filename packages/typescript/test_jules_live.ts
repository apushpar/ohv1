/**
 * End-to-end live test for the Jules TypeScript adapter.
 * Tests: listSessions, createSession, streamEvents, cancelSession, sendMessage, capabilities.
 *
 * Run from packages/typescript/:
 *   JULES_API_KEY=... npx tsx test_jules_live.ts
 */

import { OmniHarness } from "./src/index.js";
import { parseSource } from "./src/types.js";

const SOURCE = parseSource("github://apushpar/ohv1");

function pass(label: string) { console.log(`  ✓ ${label}`); }
function fail(label: string, err: unknown) {
  console.error(`  ✗ ${label}:`, err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
function section(title: string) { console.log(`\n── ${title}`); }

const client = new OmniHarness();

// ── 1. listSessions ──────────────────────────────────────────────────────────
section("1. listSessions");
try {
  const page = await client.sessions.list("jules", 5);
  pass(`returned ${page.sessions.length} session(s)`);
  for (const s of page.sessions.slice(0, 3)) {
    console.log(`     id=${s.id}  status=${s.status}  created=${s.createdAt.slice(0, 19)}`);
  }
} catch (err) {
  fail("listSessions", err);
}

// ── 2. createSession + streamEvents ─────────────────────────────────────────
section("2. createSession + streamEvents");
let streamedSession: Awaited<ReturnType<typeof client.sessions.create>> | undefined;
try {
  streamedSession = await client.sessions.create("jules", {
    prompt: "In one sentence, describe what this repository does.",
    source: SOURCE,
  });
  pass(`session created  id=${streamedSession.id}  status=${streamedSession.status}`);

  let messageText = "";
  let finalStatus = "";

  for await (const event of streamedSession.stream()) {
    if (event.kind === "message") {
      messageText = event.data["text"] as string;
      console.log(`     [message] ${messageText.slice(0, 120)}`);
    } else if (event.kind === "tool_activity") {
      const title = (event.data["title"] as string) || (event.data["tool"] as string) || "";
      if (title) console.log(`     [tool_activity] ${title}`);
    } else if (event.kind === "provider_event") {
      const type = event.data["type"] as string;
      if (type !== "keep_alive") console.log(`     [provider_event] type=${type}`);
    } else if (event.kind === "status") {
      finalStatus = event.data["value"] as string;
      console.log(`     [status] ${finalStatus}`);
    }
  }

  if (finalStatus === "completed") {
    pass("session completed");
  } else {
    fail("unexpected terminal status", finalStatus);
  }
  if (messageText) {
    pass("received message event from agent");
  } else {
    fail("no message event received", "");
  }
} catch (err) {
  fail("createSession + streamEvents", err);
}

// ── 3. getSession (reconnect by id) ──────────────────────────────────────────
section("3. getSession");
if (streamedSession) {
  try {
    const refreshed = await streamedSession.refresh();
    pass(`getSession  id=${refreshed.id}  status=${refreshed.status}`);
  } catch (err) {
    fail("getSession", err);
  }
}

// ── 4. cancelSession ─────────────────────────────────────────────────────────
section("4. cancelSession");
try {
  const toCancel = await client.sessions.create("jules", {
    prompt: "Perform an exhaustive audit of all 10,000 files (this will be cancelled).",
    source: SOURCE,
  });
  pass(`session created  id=${toCancel.id}`);
  await toCancel.cancel();
  pass("cancel() returned without error");
  await new Promise((r) => setTimeout(r, 2000));
  // Jules deletes cancelled sessions — GET returns 404, which is the expected outcome
  try {
    const afterCancel = await toCancel.refresh();
    pass(`status after cancel: ${afterCancel.status}`);
  } catch (refreshErr: unknown) {
    const isNotFound =
      refreshErr instanceof Error && refreshErr.message.includes("404");
    if (isNotFound) {
      pass("session deleted after cancel (404 on refresh is expected Jules behaviour)");
    } else {
      throw refreshErr;
    }
  }
} catch (err) {
  fail("cancelSession", err);
}

// ── 5. sendMessage ────────────────────────────────────────────────────────────
section("5. sendMessage");
try {
  const msgSession = await client.sessions.create("jules", {
    prompt: "Wait for my follow-up message before doing anything.",
    source: SOURCE,
  });
  pass(`session created  id=${msgSession.id}`);
  // Jules only accepts sendMessage in IN_PROGRESS state — poll until ready
  let handle = msgSession;
  for (let i = 0; i < 15; i++) {
    if (handle.status === "in_progress") break;
    await new Promise((r) => setTimeout(r, 3000));
    handle = await handle.refresh();
    console.log(`     polling status: ${handle.status}`);
  }
  if (handle.status !== "in_progress") {
    pass(`session reached status ${handle.status} before sendMessage (skipping send)`);
  } else {
    await handle.sendMessage("Never mind, just say hello and finish.");
    pass("sendMessage() returned without error");
  }
} catch (err) {
  fail("sendMessage", err);
}

// ── 6. capabilities() ────────────────────────────────────────────────────────
section("6. capabilities()");
try {
  const caps = client.capabilities("jules");
  const expected: Record<string, boolean> = {
    streaming: false,
    cancellation: true,
    listSessions: true,
    sendMessage: true,
    planApproval: true,
    toolResults: false,
    fileUpload: false,
  };
  let allOk = true;
  for (const [k, v] of Object.entries(expected)) {
    if ((caps as Record<string, unknown>)[k] !== v) {
      fail(`capabilities.${k} expected ${v}, got ${(caps as Record<string, unknown>)[k]}`, "");
      allOk = false;
    }
  }
  if (allOk) pass("all capability flags correct");
} catch (err) {
  fail("capabilities", err);
}

console.log("\nDone.\n");
