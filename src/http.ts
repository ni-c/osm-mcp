const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CACHE_ENTRIES = 500;
/** Hard cap on a buffered upstream response — protects the process heap. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Responses above this are served but never cached. */
const MAX_CACHEABLE_CHARS = 1024 * 1024;
/**
 * Aggregate budget for cached response text. The entry cap alone would allow
 * 500 × 1 MB — half a gigabyte held for a full hour in a memory-limited
 * container.
 */
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
/** Beyond this many queued requests per service the caller gets a fast error. */
const MAX_QUEUE_DEPTH = 32;

export class OsmApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly service: string,
    url: string
  ) {
    super(`${service} request to ${redactUrl(url)} failed with HTTP ${status}`);
    this.name = 'OsmApiError';
  }
}

/**
 * Query strings can carry credentials (an operator-supplied base URL might
 * embed one) — never let any of the common key parameter names into an error
 * message.
 */
export function redactUrl(url: string): string {
  return url.replace(
    /([?&](?:api_?key|key|token|access_token)=)[^&]*/gi,
    '$1[redacted]'
  );
}

/**
 * Serializes requests to one upstream service and enforces a minimum interval
 * between them. This is what keeps the server inside the published usage
 * policies (Nominatim and the FOSSGIS OSRM instance both allow at most one
 * request per second per client). The queue depth is capped: beyond it the
 * caller gets an immediate "busy" error instead of a multi-minute silent wait
 * that would outlive the MCP client's patience anyway.
 */
export class RateLimiter {
  private nextSlot = 0;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly maxQueue: number = MAX_QUEUE_DEPTH
  ) {}

  acquire(): Promise<void> {
    if (this.pending >= this.maxQueue) {
      return Promise.reject(
        new Error(
          'too many queued requests for this service — the rate-limit queue ' +
            'is full; retry in a moment or batch fewer locations per call'
        )
      );
    }
    this.pending += 1;
    const turn = this.queue
      .then(async () => {
        const wait = this.nextSlot - this.now();
        this.nextSlot = Math.max(this.now(), this.nextSlot) + this.intervalMs;
        if (wait > 0) {
          await this.sleep(wait);
        }
      })
      .finally(() => {
        this.pending -= 1;
      });
    // Swallow rejections on the internal chain; callers see them via `turn`.
    this.queue = turn.catch(() => {});
    return turn;
  }
}

/** Caps how many requests run against one service at the same time. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) {
      // The releaser hands its slot over without decrementing `active`, so a
      // concurrent fresh acquire() in the same microtask window still sees the
      // semaphore as full — decrement-then-resolve would briefly over-admit.
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next();
      } else {
        this.active -= 1;
      }
    };
  }
}

interface CacheEntry {
  expires: number;
  value: unknown;
  /** Length of the response text this entry was parsed from. */
  size: number;
}

/**
 * In-memory TTL cache with a hard entry cap and an aggregate size budget
 * (oldest entries are evicted first).
 */
export class TtlCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalSize = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number = MAX_CACHE_ENTRIES,
    private readonly now: () => number = () => Date.now(),
    private readonly maxBytes: number = MAX_CACHE_BYTES
  ) {}

  get(key: string): unknown {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: unknown, size = 0): void {
    if (this.ttlMs <= 0 || size > this.maxBytes) return;
    this.delete(key);
    while (
      this.entries.size > 0 &&
      (this.entries.size >= this.maxEntries ||
        this.totalSize + size > this.maxBytes)
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.entries.set(key, { expires: this.now() + this.ttlMs, value, size });
    this.totalSize += size;
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.totalSize -= entry.size;
    this.entries.delete(key);
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Skip the response cache, e.g. for endpoints with volatile output. */
  noCache?: boolean;
  timeoutMs?: number;
}

/**
 * Fetch wrapper shared by all backends: sends the identifying User-Agent,
 * never follows redirects, times out, caps the buffered response size, caches
 * identical requests for the configured TTL and throttles per service via the
 * caller-supplied limiter.
 */
export class HttpClient {
  private readonly cache: TtlCache;

  constructor(
    private readonly userAgent: string,
    cacheTtlMs: number,
    cache?: TtlCache
  ) {
    this.cache = cache ?? new TtlCache(cacheTtlMs);
  }

  async request(
    service: string,
    url: string,
    limiter: RateLimiter | null,
    options: RequestOptions = {}
  ): Promise<unknown> {
    const method = options.method ?? 'GET';
    const cacheKey = `${service} ${method} ${url} ${options.body ?? ''}`;
    if (!options.noCache) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) return cached;
    }

    if (limiter) await limiter.acquire();

    const response = await fetch(url, {
      method,
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
        ...options.headers,
      },
      body: options.body ?? null,
      // Never follow a redirect: headers would be resent to whatever host the
      // upstream points at.
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    const text = await readBodyCapped(response, service);

    if (!response.ok) {
      throw new OsmApiError(response.status, text, service, url);
    }

    let data: unknown = text;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('json') || looksLikeJson(text)) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!options.noCache && text.length <= MAX_CACHEABLE_CHARS) {
      this.cache.set(cacheKey, data, text.length);
    }
    return data;
  }
}

/**
 * Buffers the response body up to MAX_RESPONSE_BYTES and aborts beyond it —
 * an overloaded (or hostile) upstream must not be able to exhaust the heap.
 */
async function readBodyCapped(
  response: Response,
  service: string
): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) {
    throw new Error(
      `${service} response is too large (${declared} bytes, cap ${MAX_RESPONSE_BYTES})`
    );
  }
  if (!response.body) {
    return response.text();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(
        `${service} response exceeded the ${MAX_RESPONSE_BYTES}-byte cap`
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

const MAX_ERROR_BODY_LENGTH = 2000;

/**
 * Limits what an upstream error body can inject into the model context: HTML
 * error pages are dropped entirely, other bodies are truncated. Bodies often
 * echo the request line, so URL-style key parameters are redacted here too.
 */
export function sanitizeErrorBody(body: string): string {
  const trimmed = redactUrl(body.trim());
  if (/^(<!doctype\s|<html[\s>])/i.test(trimmed)) {
    return '(HTML error page omitted)';
  }
  if (trimmed.length > MAX_ERROR_BODY_LENGTH) {
    return `${trimmed.slice(0, MAX_ERROR_BODY_LENGTH)}… (truncated)`;
  }
  return trimmed;
}
