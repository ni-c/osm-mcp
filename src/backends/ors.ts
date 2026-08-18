import type { Config } from '../config.js';
import { HttpClient, RateLimiter } from '../http.js';
import type { LatLon } from '../geo.js';
import type { OsrmMatrix, OsrmRoute, Profile } from './osrm.js';
import type { IsochroneContour } from './valhalla.js';

const ORS_PROFILE: Record<Profile, string> = {
  foot: 'foot-walking',
  car: 'driving-car',
  bike: 'cycling-regular',
};

interface OrsRouteResponse {
  routes?: Array<{
    summary?: { distance?: number; duration?: number };
    segments?: Array<{
      distance: number;
      duration: number;
      steps?: Array<{ instruction?: string; distance?: number }>;
    }>;
  }>;
}

/**
 * OpenRouteService — active only when ORS_API_KEY is set; replaces OSRM for
 * routes/matrices and Valhalla for isochrones. Free-tier quotas are
 * per-endpoint (directions: 2000/day, 40/min); 403 = daily quota, 429 = minute
 * quota.
 */
export class OrsBackend {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly http: HttpClient,
    private readonly config: Config,
    limiter?: RateLimiter
  ) {
    // Stay comfortably under the 40 requests/minute sliding window.
    this.limiter = limiter ?? new RateLimiter(1600);
  }

  get enabled(): boolean {
    return Boolean(this.config.orsApiKey);
  }

  private post(path: string, body: unknown): Promise<unknown> {
    return this.http.request(
      'ors',
      `${this.config.orsUrl}${path}`,
      this.limiter,
      {
        method: 'POST',
        headers: {
          Authorization: this.config.orsApiKey ?? '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );
  }

  async route(
    profile: Profile,
    coords: LatLon[],
    includeSteps = false
  ): Promise<OsrmRoute> {
    const data = (await this.post(`/v2/directions/${ORS_PROFILE[profile]}`, {
      coordinates: coords.map((c) => [c.lon, c.lat]),
      instructions: includeSteps,
    })) as OrsRouteResponse;
    const route = data.routes?.[0];
    if (!route) throw new Error('ORS returned no route');
    return {
      distanceMeters: route.summary?.distance ?? 0,
      durationSeconds: route.summary?.duration ?? 0,
      legs: (route.segments ?? []).map((segment) => ({
        distanceMeters: segment.distance,
        durationSeconds: segment.duration,
      })),
      ...(includeSteps
        ? {
            steps: (route.segments ?? []).flatMap((segment) =>
              (segment.steps ?? []).map((step) => ({
                instruction: step.instruction ?? '',
                distanceMeters: step.distance ?? 0,
              }))
            ),
          }
        : {}),
    };
  }

  async table(
    profile: Profile,
    origins: LatLon[],
    destinations: LatLon[]
  ): Promise<OsrmMatrix> {
    const locations = [...origins, ...destinations].map((c) => [c.lon, c.lat]);
    const data = (await this.post(`/v2/matrix/${ORS_PROFILE[profile]}`, {
      locations,
      sources: origins.map((_, i) => i),
      destinations: destinations.map((_, i) => i + origins.length),
      metrics: ['distance', 'duration'],
    })) as {
      durations?: (number | null)[][];
      distances?: (number | null)[][];
    };
    return {
      durations: data.durations ?? [],
      distances: data.distances ?? [],
    };
  }

  async isochrone(
    center: LatLon,
    profile: Profile,
    options: { minutes?: number; kilometers?: number }
  ): Promise<IsochroneContour[]> {
    const isTime = options.minutes !== undefined;
    const data = (await this.post(`/v2/isochrones/${ORS_PROFILE[profile]}`, {
      locations: [[center.lon, center.lat]],
      range: [isTime ? options.minutes! * 60 : options.kilometers! * 1000],
      range_type: isTime ? 'time' : 'distance',
    })) as {
      features?: Array<{
        properties?: { value?: number };
        geometry?: { coordinates?: unknown };
      }>;
    };
    return (data.features ?? [])
      .filter((f) => f.geometry?.coordinates)
      .map((f) => ({
        // Normalize back to the Valhalla convention: minutes or kilometers.
        value: isTime
          ? (f.properties?.value ?? 0) / 60
          : (f.properties?.value ?? 0) / 1000,
        coordinates: flatten(f.geometry!.coordinates),
      }));
  }
}

function flatten(coordinates: unknown): LatLon[] {
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
