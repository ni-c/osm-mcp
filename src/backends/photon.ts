import type { Config } from '../config.js';
import { HttpClient, RateLimiter } from '../http.js';
import { isValidLatLon, roundCoord } from '../geo.js';
import type { GeocodeResult } from './nominatim.js';

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    street?: string;
    housenumber?: string;
    postcode?: string;
    city?: string;
    state?: string;
    country?: string;
    osm_type?: string;
    osm_id?: number;
    osm_key?: string;
    osm_value?: string;
  };
}

const OSM_TYPE_NAMES: Record<string, string> = {
  N: 'node',
  W: 'way',
  R: 'relation',
};

/** Photon supports only a handful of languages; anything else falls back to `default`. */
const PHOTON_LANGUAGES = new Set(['en', 'de', 'fr']);

/**
 * Photon (komoot) geocoder — fair-use public instance, typo-tolerant,
 * minutely-updated OSM data. Good for fuzzy place lookup where Nominatim
 * expects well-formed addresses.
 */
export class PhotonBackend {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly http: HttpClient,
    private readonly config: Config,
    limiter?: RateLimiter
  ) {
    this.limiter = limiter ?? new RateLimiter(1100);
  }

  async search(
    query: string,
    options: { limit?: number; language?: string } = {}
  ): Promise<GeocodeResult[]> {
    const params = new URLSearchParams({
      q: query,
      limit: String(options.limit ?? 3),
      lang: PHOTON_LANGUAGES.has(options.language ?? 'en')
        ? (options.language ?? 'en')
        : 'default',
    });
    const data = (await this.http.request(
      'photon',
      `${this.config.photonUrl}/api?${params}`,
      this.limiter
    )) as { features?: PhotonFeature[] };
    return (data.features ?? [])
      .filter((f) => f.geometry?.coordinates?.length === 2)
      .map((f) => toResult(f))
      .filter((result) => isValidLatLon(result.lat, result.lon));
  }
}

function toResult(feature: PhotonFeature): GeocodeResult {
  const [lon, lat] = feature.geometry!.coordinates!;
  const p = feature.properties ?? {};
  const label = [
    [p.name ?? p.street, p.housenumber].filter(Boolean).join(' '),
    p.postcode && p.city ? `${p.postcode} ${p.city}` : p.city,
    p.state,
    p.country,
  ]
    .filter(Boolean)
    .join(', ');
  const result: GeocodeResult = {
    lat: roundCoord(lat),
    lon: roundCoord(lon),
    label: label || '(unnamed)',
  };
  // Object.hasOwn: osm_type comes from the upstream response — a plain index
  // lookup would resolve prototype keys like "constructor" to a function.
  const osmType =
    p.osm_type && Object.hasOwn(OSM_TYPE_NAMES, p.osm_type)
      ? OSM_TYPE_NAMES[p.osm_type]
      : undefined;
  if (osmType && p.osm_id !== undefined) {
    result.osm = `${osmType}/${p.osm_id}`;
  }
  if (p.osm_key && p.osm_value) {
    result.kind = `${p.osm_key}/${p.osm_value}`;
  }
  return result;
}
