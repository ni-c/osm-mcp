import type { Config } from '../config.js';
import { HttpClient, RateLimiter } from '../http.js';
import type { LatLon } from '../geo.js';
import type { Profile } from './osrm.js';

const COSTING: Record<Profile, string> = {
  foot: 'pedestrian',
  car: 'auto',
  bike: 'bicycle',
};

export interface IsochroneContour {
  /** The contour value: minutes for time, kilometers for distance. */
  value: number;
  /** All contour ring coordinates, for bounding-box summaries. */
  coordinates: LatLon[];
}

/** FOSSGIS Valhalla instance — used for isochrones, which OSRM cannot do. */
export class ValhallaBackend {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly http: HttpClient,
    private readonly config: Config,
    limiter?: RateLimiter
  ) {
    this.limiter = limiter ?? new RateLimiter(1100);
  }

  async isochrone(
    center: LatLon,
    profile: Profile,
    options: { minutes?: number; kilometers?: number }
  ): Promise<IsochroneContour[]> {
    const contour =
      options.minutes !== undefined
        ? { time: options.minutes }
        : { distance: options.kilometers };
    const request = {
      locations: [{ lat: center.lat, lon: center.lon }],
      costing: COSTING[profile],
      contours: [contour],
      polygons: false,
    };
    const params = new URLSearchParams({ json: JSON.stringify(request) });
    const data = (await this.http.request(
      'valhalla',
      `${this.config.valhallaUrl}/isochrone?${params}`,
      this.limiter
    )) as {
      features?: Array<{
        properties?: { contour?: number };
        geometry?: { type?: string; coordinates?: unknown };
      }>;
    };
    return (data.features ?? [])
      .filter((f) => f.geometry?.coordinates)
      .map((f) => ({
        value: f.properties?.contour ?? 0,
        coordinates: flattenCoordinates(f.geometry!.coordinates),
      }));
  }
}

/** Valhalla returns LineString or MultiPolygon rings; flatten either shape. */
function flattenCoordinates(coordinates: unknown): LatLon[] {
  const points: LatLon[] = [];
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (
      node.length >= 2 &&
      typeof node[0] === 'number' &&
      typeof node[1] === 'number'
    ) {
      points.push({ lon: node[0], lat: node[1] });
      return;
    }
    for (const child of node) walk(child);
  };
  walk(coordinates);
  return points;
}
