import type { Config } from '../config.js';
import {
  endpointOrigin,
  HttpClient,
  OsmApiError,
  RateLimiter,
  Semaphore,
  upstreamText,
} from '../http.js';
import { isValidLatLon, roundCoord, type LatLon } from '../geo.js';
import {
  arrayOf,
  finiteNumber,
  nonNegativeInteger,
  objectOf,
  stringTags,
} from '../shape.js';

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  /** Present when the element (or its centre) has a valid coordinate. */
  lat?: number;
  lon?: number;
  /** Always a string-to-string map, bounded, possibly empty. */
  tags: Record<string, string>;
}

export interface Poi extends LatLon {
  osm: string;
  name: string;
  tags: Record<string, string>;
}

const ELEMENT_TYPES = new Set(['node', 'way', 'relation']);

/** The whole mirror walk, semaphore wait included; MCP SDK clients give up after 60 s. */
const WALK_BUDGET_MS = 50_000;
/** One endpoint never gets longer than this. */
const MAX_ATTEMPT_MS = 40_000;
/** Nor shorter: the queries' own server-side `[timeout:20]`. */
const MIN_ATTEMPT_MS = 20_000;
const QL_SETTINGS = '[out:json][timeout:20];';

/** Overpass answers a query that failed at runtime with HTTP 200 and a `remark`. */
export class OverpassRuntimeError extends Error {
  constructor(remark: string) {
    super(`Overpass reported ${upstreamText(remark, 120)}`);
    this.name = 'OverpassRuntimeError';
  }
}

interface Failure {
  endpoint: string;
  error: unknown;
  timeoutMs: number;
}

/**
 * Overpass API. The public main instance grants ~2 concurrent slots per IP and
 * asks clients to back off on 429 — this backend caps concurrency, and when an
 * endpoint fails for any reason but a bad query it moves on to the next
 * configured one, within one time budget for the whole walk.
 */
export class OverpassBackend {
  private readonly semaphore = new Semaphore(2);
  private readonly limiter: RateLimiter;
  private readonly retryDelay: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly warned = new Set<string>();

  constructor(
    private readonly http: HttpClient,
    private readonly config: Config,
    limiter?: RateLimiter,
    retryDelay?: (ms: number) => Promise<void>,
    now?: () => number
  ) {
    this.limiter = limiter ?? new RateLimiter(1100);
    this.retryDelay =
      retryDelay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = now ?? (() => Date.now());
  }

  /**
   * Runs a query and answers with the shaped elements. Elements the shaper
   * refuses (no type, no integer id) are dropped one by one, never the answer.
   */
  async query(ql: string): Promise<OverpassElement[]> {
    const deadline = this.now() + WALK_BUDGET_MS;
    const release = await this.semaphore.acquire();
    try {
      const urls = this.config.overpassUrls;
      const failures: Failure[] = [];
      for (const [index, endpoint] of urls.entries()) {
        if (index > 0) {
          // Never walk the mirror list back-to-back — a failing burst across
          // all public interpreters is exactly the pattern they ban clients for.
          const delay = 1000 * index;
          if (deadline - this.now() - delay < MIN_ATTEMPT_MS) {
            throw walkError(failures, urls.length);
          }
          await this.retryDelay(delay);
        }
        const share = (deadline - this.now()) / (urls.length - index);
        const timeoutMs = Math.floor(
          Math.min(MAX_ATTEMPT_MS, Math.max(MIN_ATTEMPT_MS, share))
        );
        try {
          const data = objectOf(
            await this.http.request('overpass', endpoint, this.limiter, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: `data=${encodeURIComponent(ql)}`,
              timeoutMs,
              cacheable: (answer) => runtimeError(answer) === undefined,
            })
          );
          const remark = runtimeError(data);
          if (remark !== undefined) throw new OverpassRuntimeError(remark);
          return arrayOf(data?.elements)
            .map((element) => toElement(element))
            .filter((element) => element !== null);
        } catch (error) {
          if (!worthAnotherEndpoint(error)) throw error;
          this.warnOnRefusal(index, endpoint, error);
          failures.push({ endpoint, error, timeoutMs });
        }
      }
      throw walkError(failures, urls.length);
    } finally {
      release();
    }
  }

  /** A paid endpoint with an expired key would otherwise hand its load to the public servers unnoticed. */
  private warnOnRefusal(index: number, endpoint: string, error: unknown): void {
    if (!(error instanceof OsmApiError)) return;
    if (error.status !== 401 && error.status !== 403) return;
    if (this.warned.has(endpoint)) return;
    this.warned.add(endpoint);
    console.error(
      `osm-mcp: WARNING: Overpass endpoint #${index + 1} (${endpointOrigin(endpoint)}) ` +
        `refused the request with HTTP ${error.status} — check its key`
    );
  }

  async findNearby(
    center: LatLon,
    selector: TagSelector,
    radiusMeters: number,
    limit: number
  ): Promise<Poi[]> {
    const ql =
      QL_SETTINGS +
      `nwr${selectorToQl(selector)}(around:${Math.round(radiusMeters)},${center.lat},${center.lon});` +
      `out center tags ${limit};`;
    return (await this.query(ql))
      .map((el) => toPoi(el))
      .filter((poi) => poi !== null);
  }

  async byId(
    type: 'node' | 'way' | 'relation',
    id: number
  ): Promise<OverpassElement | null> {
    const ql = `${QL_SETTINGS}${type}(${id});out center tags;`;
    const elements = await this.query(ql);
    return elements[0] ?? null;
  }
}

export interface TagSelector {
  key: string;
  value?: string;
}

const TAG_PART = /^[A-Za-z0-9_:-]+$/;

/**
 * Validates a `key` or `key=value` tag filter. The strict charset is what makes
 * interpolating it into Overpass QL safe — anything else is rejected before it
 * reaches the query.
 */
export function parseTagSelector(input: string): TagSelector {
  const [key, value, ...rest] = input.split('=');
  if (
    rest.length > 0 ||
    !key ||
    !TAG_PART.test(key) ||
    (value !== undefined && !TAG_PART.test(value))
  ) {
    throw new Error(
      `invalid tag filter "${input}" — use "key" or "key=value" with letters, ` +
        'digits, underscore, colon and hyphen only (e.g. "amenity=restaurant")'
    );
  }
  return value === undefined ? { key } : { key, value };
}

function selectorToQl(selector: TagSelector): string {
  return selector.value === undefined
    ? `["${selector.key}"]`
    : `["${selector.key}"="${selector.value}"]`;
}

/**
 * One raw Overpass element as the shape the tools read, or null when it has
 * no type or no integer id. Coordinates are taken from the element or its
 * `center`, and only when they are finite and on the globe; tags are always a
 * bounded string map — a mirror that sends `null` for a value, or an object,
 * sends no tag.
 */
export function toElement(raw: unknown): OverpassElement | null {
  const element = objectOf(raw);
  if (!element) return null;
  const type = element.type;
  if (typeof type !== 'string' || !ELEMENT_TYPES.has(type)) return null;
  const id = nonNegativeInteger(element.id);
  if (id === undefined) return null;
  const center = objectOf(element.center);
  const lat = finiteNumber(element.lat) ?? finiteNumber(center?.lat);
  const lon = finiteNumber(element.lon) ?? finiteNumber(center?.lon);
  return {
    type: type as OverpassElement['type'],
    id,
    ...(lat !== undefined && lon !== undefined && isValidLatLon(lat, lon)
      ? { lat: roundCoord(lat), lon: roundCoord(lon) }
      : {}),
    tags: stringTags(element.tags),
  };
}

function toPoi(element: OverpassElement): Poi | null {
  if (element.lat === undefined || element.lon === undefined) return null;
  return {
    osm: `${element.type}/${element.id}`,
    lat: element.lat,
    lon: element.lon,
    name: element.tags.name ?? '(unnamed)',
    tags: element.tags,
  };
}

/** Only a bad query (400) or a local failure is the same on every endpoint. */
function worthAnotherEndpoint(error: unknown): boolean {
  if (error instanceof OsmApiError) return error.status !== 400;
  return (
    isTimeout(error) ||
    isNetworkFailure(error) ||
    error instanceof OverpassRuntimeError
  );
}

/** `AbortSignal.timeout` rejects with a `TimeoutError`, while fetching or while reading the body. */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

/** undici: `fetch failed` / `terminated`, always with the socket error as cause. */
function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && error.cause !== undefined;
}

function runtimeError(answer: unknown): string | undefined {
  const remark = objectOf(answer)?.remark;
  return typeof remark === 'string' && remark.includes('runtime error')
    ? remark
    : undefined;
}

function failureReason({ error, timeoutMs }: Failure): string {
  if (error instanceof OsmApiError) return `HTTP ${error.status}`;
  if (isTimeout(error)) {
    return `no answer within ${Math.round(timeoutMs / 1000)} s`;
  }
  if (error instanceof OverpassRuntimeError) return error.message;
  const code = objectOf((error as Error).cause)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(code)
    ? `unreachable (${code})`
    : 'unreachable (network error)';
}

/** Overload, as opposed to an endpoint that refuses or cannot be reached. */
function looksBusy({ error }: Failure): boolean {
  if (error instanceof OsmApiError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return isTimeout(error) || error instanceof OverpassRuntimeError;
}

function walkError(failures: Failure[], endpoints: number): Error {
  const parts = failures.map(
    (failure, index) =>
      `#${index + 1} ${endpointOrigin(failure.endpoint)}: ${failureReason(failure)}`
  );
  const first = failures.length + 1;
  if (first <= endpoints) {
    const range =
      first === endpoints ? `#${first}` : `#${first} to #${endpoints}`;
    parts.push(`${range} not tried: time budget used up`);
  }
  return new Error(
    `all Overpass endpoints failed (${parts.join('; ')}). ` +
      (failures.some(looksBusy)
        ? 'The public servers may be overloaded — wait ~30 seconds and retry.'
        : 'No endpoint accepted the request — check OVERPASS_BASE_URL (addresses, keys) and the network.')
  );
}
