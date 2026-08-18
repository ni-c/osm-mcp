import type { Config } from '../config.js';
import { HttpClient, RateLimiter } from '../http.js';
import { isValidLatLon, roundCoord } from '../geo.js';

export interface GeocodeResult {
  lat: number;
  lon: number;
  /** Human-readable place label, e.g. the Nominatim display name. */
  label: string;
  /** OSM element reference like `node/240109189`, when known. */
  osm?: string;
  /** Element class/type, e.g. `tourism/museum`. */
  kind?: string;
}

interface NominatimPlace {
  lat: string;
  lon: string;
  display_name?: string;
  osm_type?: string;
  osm_id?: number;
  category?: string;
  type?: string;
}

/**
 * Nominatim public API. Usage policy: at most 1 request/second, identifying
 * User-Agent required, results must be cached — the shared HttpClient and the
 * limiter here implement exactly that.
 */
export class NominatimBackend {
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
    options: { limit?: number; language?: string; countrycodes?: string } = {}
  ): Promise<GeocodeResult[]> {
    const params = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      limit: String(options.limit ?? 3),
      'accept-language': options.language ?? 'en',
    });
    if (options.countrycodes) {
      params.set('countrycodes', options.countrycodes.toLowerCase());
    }
    const data = (await this.http.request(
      'nominatim',
      `${this.config.nominatimUrl}/search?${params}`,
      this.limiter
    )) as NominatimPlace[];
    return data
      .map((place) => toResult(place))
      .filter((result) => isValidLatLon(result.lat, result.lon));
  }

  async reverse(
    lat: number,
    lon: number,
    language = 'en'
  ): Promise<GeocodeResult | null> {
    const params = new URLSearchParams({
      lat: String(lat),
      lon: String(lon),
      format: 'jsonv2',
      'accept-language': language,
    });
    const data = (await this.http.request(
      'nominatim',
      `${this.config.nominatimUrl}/reverse?${params}`,
      this.limiter
    )) as NominatimPlace & { error?: string };
    if (data.error || data.lat === undefined) return null;
    const result = toResult(data);
    return isValidLatLon(result.lat, result.lon) ? result : null;
  }
}

function toResult(place: NominatimPlace): GeocodeResult {
  const result: GeocodeResult = {
    lat: roundCoord(Number(place.lat)),
    lon: roundCoord(Number(place.lon)),
    label: place.display_name ?? '(unnamed)',
  };
  if (place.osm_type && place.osm_id !== undefined) {
    result.osm = `${place.osm_type}/${place.osm_id}`;
  }
  if (place.category && place.type) {
    result.kind = `${place.category}/${place.type}`;
  }
  return result;
}
