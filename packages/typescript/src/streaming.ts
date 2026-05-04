import type { Event, ProviderId, Session } from "./types.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export async function* pollingStream(options: {
  provider: ProviderId;
  sessionId: string;
  fetchSession: () => Promise<Session>;
  fetchNewEvents: (cursor: string | undefined) => Promise<[Event[], string | undefined]>;
  pollBase?: number;
  pollCap?: number;
  keepaliveSecs?: number;
}): AsyncIterableIterator<Event> {
  const {
    provider,
    sessionId,
    fetchSession,
    fetchNewEvents,
    pollBase = 1000,
    pollCap = 15000,
    keepaliveSecs = 30,
  } = options;

  let seq = 0;
  let idleCount = 0;
  let cursor: string | undefined;
  let lastActivity = Date.now();

  while (true) {
    const session = await fetchSession();
    const [events, nextCursor] = await fetchNewEvents(cursor);
    if (nextCursor !== undefined) cursor = nextCursor;

    for (const ev of events) {
      ev.seq = seq++;
      idleCount = 0;
      lastActivity = Date.now();
      yield ev;
    }

    if (TERMINAL_STATUSES.has(session.status)) {
      yield {
        kind: "status",
        sessionId,
        provider,
        ts: new Date().toISOString(),
        seq: seq++,
        data: { value: session.status },
      };
      return;
    }

    const now = Date.now();
    if ((now - lastActivity) / 1000 > keepaliveSecs) {
      yield {
        kind: "provider_event",
        sessionId,
        provider,
        ts: new Date().toISOString(),
        seq: seq++,
        data: { type: "keep_alive" },
      };
      lastActivity = now;
    }

    await sleep(Math.min(pollCap, pollBase * Math.pow(2, Math.min(idleCount, 4))));
    idleCount = events.length > 0 ? 0 : idleCount + 1;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function* claudeSseStream(
  baseUrl: string,
  apiKey: string,
  extraHeaders: Record<string, string>,
  sessionId: string,
  sinceProcessedAt: string | undefined,
): AsyncIterableIterator<Record<string, unknown>> {
  const seenIds = new Set<string>();
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    ...extraHeaders,
  };

  if (sinceProcessedAt) {
    const url = new URL(`${baseUrl}/v1/sessions/${sessionId}/events`);
    url.searchParams.set("processed_at_gt", sinceProcessedAt);
    const resp = await fetch(url.toString(), { headers });
    if (resp.ok) {
      const data = (await resp.json()) as { events?: Array<Record<string, unknown>> };
      for (const ev of data.events ?? []) {
        const id = ev["id"] as string | undefined;
        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          yield ev;
        }
      }
    }
  }

  const streamUrl = `${baseUrl}/v1/sessions/${sessionId}/events/stream`;
  const resp = await fetch(streamUrl, { headers });
  if (!resp.ok || !resp.body) return;

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") return;
      try {
        const data = JSON.parse(payload) as Record<string, unknown>;
        const id = data["id"] as string | undefined;
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        yield data;
      } catch {
        // malformed SSE frame — skip
      }
    }
  }
}
