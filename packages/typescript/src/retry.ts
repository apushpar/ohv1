import { ProviderError } from "./errors.js";

export function jitter(base: number, cap: number, attempt: number): number {
  return Math.random() * Math.min(cap, base * Math.pow(2, attempt));
}

export async function retryAsync<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    baseDelay?: number;
    capDelay?: number;
    provider?: string;
  } = {},
): Promise<T> {
  const { maxAttempts = 3, baseDelay = 1000, capDelay = 30000, provider = "unknown" } = options;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err instanceof ProviderError) {
        if (!err.retryable || attempt === maxAttempts - 1) throw err;
        const delay = err.retryAfter != null ? err.retryAfter * 1000 : jitter(baseDelay, capDelay, attempt);
        await sleep(delay);
      } else {
        if (attempt === maxAttempts - 1) {
          throw new ProviderError("transient", String(err), provider, true);
        }
        await sleep(jitter(baseDelay, capDelay, attempt));
      }
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CircuitBreaker {
  private failures: number[] = [];
  private openSince: number | null = null;

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly windowMs: number = 60_000,
    private readonly recoveryMs: number = 30_000,
  ) {}

  recordFailure(): void {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < this.windowMs);
    this.failures.push(now);
    if (this.failures.length >= this.failureThreshold) {
      this.openSince = now;
    }
  }

  recordSuccess(): void {
    this.failures = [];
    this.openSince = null;
  }

  get isOpen(): boolean {
    if (this.openSince === null) return false;
    if (Date.now() - this.openSince > this.recoveryMs) {
      this.openSince = null;
      return false;
    }
    return true;
  }
}
