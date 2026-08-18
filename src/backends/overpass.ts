import type { Config } from '../config.js';
import { HttpClient, OsmApiError, RateLimiter, Semaphore } from '../http.js';
import { roundCoord, type LatLon } from '../geo.js';

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface Poi extends LatLon {
  osm: string;
  name: string;
  tags: Record<string, string>;
}

/**
 * Overpass API. The public main instance grants ~2 concurrent slots per IP and
 * asks clients to back off on 429 — this backend caps concurrency, and on
 * 429/5xx fails over to the next configured mirror instead of hammering the
 * same server.
 */
export class OverpassBackend {
  private readonly semaphore = new Semaphore(2);
  private readonly limiter: RateLimiter;
  private readonly retryDelay: (ms: number) => Promise<void>;

  constructor(
    private readonly http: HttpClient,
    private readonly config: Config,
    limiter?: RateLimiter,
    retryDelay?: (ms: number) => Promise<void>
  ) {
    this.limiter = limiter ?? new RateLimiter(1100);
    this.retryDelay =
      retryDelay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async query(ql: string): Promise<OverpassElement[]> {
    const release = await this.semaphore.acquire();
    try {
      let lastError: unknown;
      let attempt = 0;
      for (const endpoint of this.config.overpassUrls) {
        // Never walk the mirror list back-to-back — a failing burst across
        // all public interpreters is exactly the pattern they ban clients for.
        if (attempt > 0) await this.retryDelay(1000 * attempt);
        attempt += 1;
        try {
          const data = (await this.http.request(
            'overpass',
            endpoint,
            this.limiter,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: `data=${encodeURIComponent(ql)}`,
              timeoutMs: 40_000,
            }
          )) as { elements?: OverpassElement[] };
          return data.elements ?? [];
        } catch (error) {
          lastError = error;
          const status = error instanceof OsmApiError ? error.status : 0;
          // 429/504 = out of slots, 5xx = instance trouble: try the mirror.
          // Anything else (bad query, network refusal) will not improve there.
          if (status === 429 || status >= 500) continue;
          throw error;
        }
      }
      throw lastError instanceof Error
        ? new Error(
            `all Overpass endpoints failed (last: ${lastError.message}). ` +
              'The public servers may be overloaded — wait ~30 seconds and retry.'
          )
        : lastError;
    } finally {
      release();
    }
  }

  async findNearby(
    center: LatLon,
    selector: TagSelector,
    radiusMeters: number,
    limit: number
  ): Promise<Poi[]> {
    const ql =
      `[out:json][timeout:25];` +
      `nwr${selectorToQl(selector)}(around:${Math.round(radiusMeters)},${center.lat},${center.lon});` +
      `out center tags ${limit};`;
    return (await this.query(ql)).map((el) => toPoi(el)).filter(isComplete);
  }

  async byId(
    type: 'node' | 'way' | 'relation',
    id: number
  ): Promise<OverpassElement | null> {
    const ql = `[out:json][timeout:25];${type}(${id});out center tags;`;
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

function toPoi(element: OverpassElement): Partial<Poi> & { osm: string } {
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  return {
    osm: `${element.type}/${element.id}`,
    ...(lat !== undefined && lon !== undefined
      ? { lat: roundCoord(lat), lon: roundCoord(lon) }
      : {}),
    name: element.tags?.name ?? '(unnamed)',
    tags: element.tags ?? {},
  };
}

function isComplete(poi: Partial<Poi> & { osm: string }): poi is Poi {
  return poi.lat !== undefined && poi.lon !== undefined;
}
