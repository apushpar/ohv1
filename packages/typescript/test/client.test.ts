import { describe, it, expect } from "vitest";
import { OmniHarness } from "../src/client.js";
import { AdapterDeprecatedError, ProviderError } from "../src/errors.js";

describe("OmniHarness client", () => {
  it("capabilities returns correct flags for jules", () => {
    const client = new OmniHarness();
    const caps = client.capabilities("jules");
    expect(caps.planApproval).toBe(true);
    expect(caps.streaming).toBe(false);
    expect(caps.cancellation).toBe(true);
  });

  it("capabilities returns correct flags for claude", () => {
    const client = new OmniHarness();
    const caps = client.capabilities("claude");
    expect(caps.toolResults).toBe(true);
    expect(caps.fileUpload).toBe(true);
    expect(caps.planApproval).toBe(false);
  });

  it("capabilities returns correct flags for openhands", () => {
    const client = new OmniHarness();
    const caps = client.capabilities("openhands");
    expect(caps.cancellation).toBe(false);
    expect(caps.sendMessage).toBe(false);
  });

  it("capabilities returns correct flags for cursor", () => {
    const client = new OmniHarness();
    const caps = client.capabilities("cursor");
    expect(caps.listSessions).toBe(false);
    expect(caps.sendMessage).toBe(false);
  });

  it("capabilities returns correct flags for devin", () => {
    const client = new OmniHarness();
    const caps = client.capabilities("devin");
    expect(caps.sendMessage).toBe(true);
    expect(caps.cancellation).toBe(true);
  });

  it("unknown version raises AdapterDeprecatedError", () => {
    const client = new OmniHarness({ providerKeys: { jules: "fake" } });
    expect(() => client._getProvider("jules", "v999")).toThrow(AdapterDeprecatedError);
  });

  it("devin missing org_id raises ProviderError", () => {
    // Remove DEVIN_ORG_ID from env if set
    const saved = process.env["DEVIN_ORG_ID"];
    delete process.env["DEVIN_ORG_ID"];
    try {
      const client = new OmniHarness({ providerKeys: { devin: "cog_fake", devin_org_id: "" } });
      expect(() => client._getProvider("devin")).toThrow(ProviderError);
    } finally {
      if (saved !== undefined) process.env["DEVIN_ORG_ID"] = saved;
    }
  });

  it("provider is cached across calls", () => {
    const client = new OmniHarness({ providerKeys: { jules: "fake" } });
    const p1 = client._getProvider("jules");
    const p2 = client._getProvider("jules");
    expect(p1).toBe(p2);
  });
});
