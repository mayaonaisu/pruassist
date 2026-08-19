import { Redis } from "@upstash/redis";

// A tiny key/value seam with a TTL, so the session and consent registries don't care whether
// they're backed by process memory or Redis.
//
// This exists because the app is deployed on serverless functions: each API route can run on a
// different instance, and a plain module-level Map is NOT shared between them. The rep would
// create a session on one instance and the customer's join link would hit another, so links
// would fail intermittently rather than outright.
export interface Store {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
}

// Advisory sessions are short-lived; expiring them keeps the store from growing forever.
export const DEFAULT_TTL = 60 * 60 * 24;

type Entry = { value: unknown; expiresAt: number };

// Hung off globalThis rather than a module-level const: in dev, a hot reload re-evaluates the
// module and a plain `new Map()` would silently start over, which shows up as a live session
// suddenly reporting "No active session for this room".
const memory: Map<string, Entry> =
  ((globalThis as { __pruStore?: Map<string, Entry> }).__pruStore ??= new Map());

class MemoryStore implements Store {
  async get<T>(key: string): Promise<T | null> {
    const hit = memory.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      memory.delete(key);
      return null;
    }
    return hit.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds = DEFAULT_TTL): Promise<void> {
    memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
}

class RedisStore implements Store {
  constructor(private redis: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    return (await this.redis.get<T>(key)) ?? null;
  }

  async set<T>(key: string, value: T, ttlSeconds = DEFAULT_TTL): Promise<void> {
    await this.redis.set(key, value, { ex: ttlSeconds });
  }
}

// Upstash's own integration and Vercel's Marketplace one name these differently.
function redisFromEnv(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

let store: Store | null = null;

// Redis when it's configured, process memory otherwise — so `npm run dev` needs no setup, while
// a deployed instance shares state across every serverless invocation.
export function getStore(): Store {
  if (!store) {
    const redis = redisFromEnv();
    store = redis ? new RedisStore(redis) : new MemoryStore();
    if (!redis && process.env.NODE_ENV === "production") {
      console.warn(
        "[store] No Redis configured — falling back to in-process memory. On serverless this " +
          "loses sessions between requests; set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      );
    }
  }
  return store;
}
