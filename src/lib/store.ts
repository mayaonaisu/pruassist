import { Redis } from "@upstash/redis";

// Key/value seam with a TTL: serverless instances share no memory, so a Map would break join links.
export interface Store {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  // Append-only queue. Two writers on one key lose updates under read-modify-write, so rep
  // actions go to their own list and the deep pass drains it — never a shared get/set.
  append<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  drain<T>(key: string): Promise<T[]>;
  // Compare-and-set on a revision-stamped value: write `next` only if the stored value's `rev`
  // still equals `expectedRev` (or nothing is stored yet). Atomic — the guard and the write are
  // one operation — so two writers that both read the same rev cannot both win. Returns whether
  // the write happened.
  casByRev<T extends { rev: number }>(key: string, expectedRev: number, next: T, ttlSeconds?: number): Promise<boolean>;
}

// Advisory sessions are short-lived; expiring them keeps the store from growing forever.
export const DEFAULT_TTL = 60 * 60 * 24;

type Entry = { value: unknown; expiresAt: number };

// On globalThis, not a module const: a dev hot reload would silently reset a live session.
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

  async del(key: string): Promise<void> {
    memory.delete(key);
  }

  async append<T>(key: string, value: T, ttlSeconds = DEFAULT_TTL): Promise<void> {
    const existing = (await this.get<T[]>(key)) ?? [];
    await this.set(key, [...existing, value], ttlSeconds);
  }

  async drain<T>(key: string): Promise<T[]> {
    const items = (await this.get<T[]>(key)) ?? [];
    if (items.length) memory.delete(key);
    return items;
  }

  // Single-threaded: nothing runs between the read and the write, so this is atomic by construction.
  async casByRev<T extends { rev: number }>(key: string, expectedRev: number, next: T, ttlSeconds = DEFAULT_TTL): Promise<boolean> {
    const hit = memory.get(key);
    const live = hit && hit.expiresAt > Date.now();
    if (live && (hit!.value as { rev?: number })?.rev !== expectedRev) return false;
    memory.set(key, { value: next, expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
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

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  // RPUSH takes no read, so concurrent writers cannot clobber each other.
  async append<T>(key: string, value: T, ttlSeconds = DEFAULT_TTL): Promise<void> {
    await this.redis.rpush<T>(key, value);
    await this.redis.expire(key, ttlSeconds);
  }

  // LPOP with a count removes exactly what it returns, so an append landing mid-drain survives
  // to the next pass instead of being deleted unread.
  async drain<T>(key: string): Promise<T[]> {
    const items = await this.redis.lpop<T[]>(key, 100);
    return Array.isArray(items) ? items : [];
  }

  // Upstash's REST client has no WATCH/MULTI, so the check-and-write is done atomically inside a
  // Lua script (server-side, single round trip). cjson.decode reads the stored value's rev; a
  // pcall keeps a non-JSON value from throwing. The value is stored as a JSON string — exactly
  // what get() then parses back — so this stays interchangeable with set().
  async casByRev<T extends { rev: number }>(key: string, expectedRev: number, next: T, ttlSeconds = DEFAULT_TTL): Promise<boolean> {
    const script =
      "local cur = redis.call('GET', KEYS[1]) " +
      "if cur then local ok, d = pcall(cjson.decode, cur) " +
      "if ok and d.rev ~= tonumber(ARGV[1]) then return 0 end end " +
      "redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3])) return 1";
    const res = await this.redis.eval(script, [key], [String(expectedRev), JSON.stringify(next), String(ttlSeconds)]);
    return Number(res) === 1;
  }
}

// Upstash's own integration and Vercel's Marketplace one name these differently.
function redisFromEnv(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

let store: Store | null = null;

// Redis when configured, process memory otherwise.
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
