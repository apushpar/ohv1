import type { ReplayToken } from "../types.js";

export interface SupportsPlanApproval {
  approvePlan(sessionId: string, replayToken?: ReplayToken): Promise<void>;
}

export interface SupportsToolResults {
  sendToolResult(
    sessionId: string,
    toolUseId: string,
    result: unknown,
    replayToken?: ReplayToken,
  ): Promise<void>;
}

export interface SupportsFileUpload {
  uploadFile(content: Uint8Array, name: string, mimeType?: string): Promise<string>;
}
