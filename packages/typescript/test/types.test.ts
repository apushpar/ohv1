import { describe, it, expect } from "vitest";
import { ReplayToken, parseSource, getPullRequestUrl } from "../src/types.js";
import type { Session, Artifact } from "../src/types.js";

describe("parseSource", () => {
  it("parses github URI with branch", () => {
    const s = parseSource("github://owner/repo@main");
    expect(s.kind).toBe("github");
    expect(s.branch).toBe("main");
  });

  it("parses github URI without branch", () => {
    const s = parseSource("github://owner/repo");
    expect(s.kind).toBe("github");
    expect(s.branch).toBeUndefined();
  });

  it("parses none URI", () => {
    const s = parseSource("none:");
    expect(s.kind).toBe("none");
  });

  it("parses local URI", () => {
    const s = parseSource("local:///path/to/repo");
    expect(s.kind).toBe("local");
  });

  it("throws on unknown scheme", () => {
    expect(() => parseSource("ftp://unknown")).toThrow("Unrecognised source URI");
  });
});

describe("ReplayToken", () => {
  it("round-trips encode/decode", () => {
    const data = { session_id: "ses_123", agent_id: "agt_456" };
    const token = ReplayToken._encode(data);
    expect(token._decode()).toEqual(data);
  });

  it("toString returns base64 string", () => {
    const token = ReplayToken._encode({ key: "value" });
    const s = token.toString();
    expect(typeof s).toBe("string");
    // should be base64 — only base64 chars
    expect(s).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("fromString round-trips", () => {
    const data = { session_id: "ses_001" };
    const token = ReplayToken._encode(data);
    const reconstructed = ReplayToken.fromString(token.toString());
    expect(reconstructed._decode()).toEqual(data);
  });

  it("empty dict round-trips", () => {
    const token = ReplayToken._encode({});
    expect(token._decode()).toEqual({});
  });
});

describe("getPullRequestUrl", () => {
  function makeSession(artifacts: Artifact[]): Session {
    return {
      id: "ses_1",
      provider: "jules",
      status: "completed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifacts,
    };
  }

  it("returns undefined when no artifacts", () => {
    expect(getPullRequestUrl(makeSession([]))).toBeUndefined();
  });

  it("returns PR url when present", () => {
    const s = makeSession([
      { kind: "pull_request", provider: "jules", url: "https://github.com/pr/1" },
    ]);
    expect(getPullRequestUrl(s)).toBe("https://github.com/pr/1");
  });

  it("returns undefined when PR has no url", () => {
    const s = makeSession([{ kind: "pull_request", provider: "jules" }]);
    expect(getPullRequestUrl(s)).toBeUndefined();
  });

  it("skips non-PR artifacts", () => {
    const s = makeSession([
      { kind: "file", provider: "jules", url: "https://example.com/file" },
    ]);
    expect(getPullRequestUrl(s)).toBeUndefined();
  });
});
