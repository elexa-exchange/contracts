import { TonClient } from "@ton/ton";

/**
 * A toncenter client that survives the free tier.
 *
 * Shared by `deploy.ts` and `allow-asset.ts`. Both make several calls in quick
 * succession — is it deployed, what is its balance, what is the seqno — and
 * without an API key toncenter allows roughly one request a second and answers
 * the rest with HTTP 429.
 *
 * Left unhandled that surfaces as forty lines of `AxiosError` with the actual
 * problem, `'Ratelimit exceed'`, buried in the middle. Since every operator
 * starts without an API key, the throttling is the normal path, not an edge
 * case: retry it, and if it persists say what to do about it.
 */

/** Minimum gap between calls when running unauthenticated. */
const ANONYMOUS_SPACING_MS = 1100;

export function makeClient(network: "mainnet" | "testnet") {
  const apiKey = process.env.TONCENTER_API_KEY;
  const client = new TonClient({
    endpoint:
      network === "mainnet"
        ? "https://toncenter.com/api/v2/jsonRPC"
        : "https://testnet.toncenter.com/api/v2/jsonRPC",
    apiKey,
    // The default is 30s, which the anonymous tier exceeds under load. A slow
    // answer is more useful than a timeout when the alternative is re-running a
    // script that has already broadcast a transaction.
    timeout: 60_000,
  });

  if (!apiKey) {
    console.log(
      "No TONCENTER_API_KEY set — running on the anonymous rate limit, which is\n" +
        "slow and flaky. Get one free from @tonapibot on Telegram and add it to\n" +
        `contracts/ton/.env.${network} if this struggles.\n`,
    );
  }

  return { client, hasApiKey: Boolean(apiKey) };
}

const isRateLimit = (error: unknown): boolean => {
  const status = (error as { response?: { status?: number }; status?: number })?.response?.status
    ?? (error as { status?: number })?.status;
  return status === 429;
};

/**
 * Run `operation`, retrying while toncenter is rate-limiting us.
 *
 * Only retries 429. Anything else — a bad address, a malformed message — is a
 * real failure that retrying would only delay, and swallowing it here would
 * turn a clear error into a slow one.
 */
export async function withRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const attempts = 8;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isRateLimit(error) || attempt === attempts) {
        if (isRateLimit(error)) {
          throw new Error(
            `toncenter is still rate-limiting after ${attempts} attempts (${label}). ` +
              `Set TONCENTER_API_KEY in the .env.<network> file — get one free from ` +
              `@tonapibot on Telegram.`,
          );
        }
        throw error;
      }
      // Linear rather than exponential: this is a fixed requests-per-second
      // ceiling, not congestion, so waiting twice as long each time overshoots.
      const wait = ANONYMOUS_SPACING_MS * attempt;
      console.log(`  rate-limited on ${label}, retrying in ${wait}ms…`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw new Error("unreachable");
}

/** Pause long enough that the next unauthenticated call is not refused. */
export async function spaceCalls() {
  if (process.env.TONCENTER_API_KEY) return;
  await new Promise((resolve) => setTimeout(resolve, ANONYMOUS_SPACING_MS));
}
