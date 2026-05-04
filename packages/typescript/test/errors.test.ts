import { describe, it, expect } from "vitest";
import {
  classifyHttpError,
  OmniHarnessError,
  ProviderError,
  UnsupportedCapability,
  ProviderLanguageError,
  AdapterDeprecatedError,
} from "../src/errors.js";

describe("classifyHttpError", () => {
  function classify(status: number, retryAfter?: string) {
    const headers: Record<string, string> = {};
    if (retryAfter !== undefined) headers["retry-after"] = retryAfter;
    return classifyHttpError(status, {}, "test", headers);
  }

  it("401 → auth non-retryable", () => {
    const e = classify(401);
    expect(e.kind).toBe("auth");
    expect(e.retryable).toBe(false);
    expect(e.httpStatus).toBe(401);
  });

  it("403 → auth non-retryable", () => {
    const e = classify(403);
    expect(e.kind).toBe("auth");
  });

  it("404 → not_found", () => {
    const e = classify(404);
    expect(e.kind).toBe("not_found");
    expect(e.retryable).toBe(false);
  });

  it("429 → rate_limit retryable with retry-after", () => {
    const e = classify(429, "10");
    expect(e.kind).toBe("rate_limit");
    expect(e.retryable).toBe(true);
    expect(e.retryAfter).toBe(10);
  });

  it("429 without retry-after", () => {
    const e = classify(429);
    expect(e.retryAfter).toBeUndefined();
  });

  it("400 → invalid_request", () => {
    const e = classify(400);
    expect(e.kind).toBe("invalid_request");
    expect(e.retryable).toBe(false);
  });

  it("503 → overloaded retryable", () => {
    const e = classify(503);
    expect(e.kind).toBe("overloaded");
    expect(e.retryable).toBe(true);
  });

  it("500 → transient retryable", () => {
    const e = classify(500);
    expect(e.kind).toBe("transient");
    expect(e.retryable).toBe(true);
  });

  it("418 → provider_quirk", () => {
    const e = classify(418);
    expect(e.kind).toBe("provider_quirk");
    expect(e.retryable).toBe(false);
  });

  it("invalid retry-after → undefined", () => {
    const e = classify(429, "not-a-number");
    expect(e.retryAfter).toBeUndefined();
  });
});

describe("Error hierarchy", () => {
  it("ProviderError extends OmniHarnessError", () => {
    const e = new ProviderError("auth", "msg", "p", false);
    expect(e).toBeInstanceOf(OmniHarnessError);
  });

  it("UnsupportedCapability message contains provider and feature", () => {
    const e = new UnsupportedCapability("jules", "tool_results");
    expect(e.message).toContain("jules");
    expect(e.message).toContain("tool_results");
    expect(e.provider).toBe("jules");
    expect(e.feature).toBe("tool_results");
  });

  it("ProviderLanguageError", () => {
    const e = new ProviderLanguageError("cursor", "typescript", "npm install omniharness");
    expect(e.message).toContain("cursor");
    expect(e.message).toContain("typescript");
    expect(e.requiredLanguage).toBe("typescript");
  });

  it("AdapterDeprecatedError", () => {
    const e = new AdapterDeprecatedError("jules", "v0", "v1alpha");
    expect(e.message).toContain("jules");
    expect(e.message).toContain("v0");
    expect(e.message).toContain("v1alpha");
    expect(e.provider).toBe("jules");
    expect(e.version).toBe("v0");
    expect(e.replacement).toBe("v1alpha");
  });
});
