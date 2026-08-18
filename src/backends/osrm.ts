import type { Config } from '../config.js';
import { HttpClient, RateLimiter } from '../http.js';
import type { LatLon } from '../geo.js';

export type Profile = 'foot' | 'car' | 'bike';

/**
 * On the FOSSGIS instance (routing.openstreetmap.de) the profile is selected
 * exclusively by this path prefix. The profile segment inside the OSRM path
 * (`/route/v1/driving/…`) is NOT evaluated by the demo servers — putting
 * `walking` there silently returns car routes, a bug most OSM wrappers share.
 */
const PROFILE_PREFIX: Record<Profile, string> = {
  car: 'routed-car',
  bike: 'routed-bike',
  foot: 'routed-foot',
};

export interface OsrmLeg {
  distanceMeters: number;
  durationSeconds: number;
  summary?: string;
}

export interface OsrmStep {
  instruction: string;
  distanceMeters: number;
}

export interface OsrmRoute {
  distanceMeters: number;
  durationSeconds: number;
  legs: OsrmLeg[];
  steps?: OsrmStep[];
}

export interface OsrmMatrix {
  /** durations[i][j] in seconds, null where no route exists. */
  durations: (number | null)[][];
  /** distances[i][j] in meters, null where no route exists. */
  distances: (number | null)[][];
}

export interface OsrmTrip {
  /** Visiting order as indices into the input coordinate list. */
  order: number[];
  distanceMeters: number;
  durationSeconds: number;
  legs: OsrmLeg[];
}

interface RawRoute {
  distance: number;
  duration: number;
  legs?: Array<{
    distance: number;
    duration: number;
    summary?: string;
    steps?: Array<{
      distance: number;
      name?: string;
      maneuver?: { type?: string; modifier?: string };
    }>;
  }>;
}

/** OSRM demo instance operated by FOSSGIS — max 1 request/second, fair use. */
export class OsrmBackend {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly http: HttpClient,
    private readonly config: Config,
    limiter?: RateLimiter
  ) {
    this.limiter = limiter ?? new RateLimiter(1100);
  }

  private url(profile: Profile, service: string, coords: LatLon[]): string {
    const path = coords.map((c) => `${c.lon},${c.lat}`).join(';');
    // The inner `driving` segment is intentional — see PROFILE_PREFIX.
    return `${this.config.osrmUrl}/${PROFILE_PREFIX[profile]}/${service}/v1/driving/${path}`;
  }

  async route(
    profile: Profile,
    coords: LatLon[],
    includeSteps = false
  ): Promise<OsrmRoute> {
    const params = new URLSearchParams({
      overview: 'false',
      alternatives: 'false',
      steps: includeSteps ? 'true' : 'false',
    });
    const data = (await this.http.request(
      'osrm',
      `${this.url(profile, 'route', coords)}?${params}`,
      this.limiter
    )) as { code?: string; message?: string; routes?: RawRoute[] };
    const route = expectOk(data, 'route').routes?.[0];
    if (!route) throw new Error('OSRM returned no route');
    return {
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      legs: toLegs(route),
      ...(includeSteps ? { steps: toSteps(route) } : {}),
    };
  }

  async table(
    profile: Profile,
    origins: LatLon[],
    destinations: LatLon[]
  ): Promise<OsrmMatrix> {
    const coords = [...origins, ...destinations];
    const sources = origins.map((_, i) => i).join(';');
    const dests = destinations.map((_, i) => i + origins.length).join(';');
    const params = new URLSearchParams({
      annotations: 'duration,distance',
      sources,
      destinations: dests,
    });
    const data = (await this.http.request(
      'osrm',
      `${this.url(profile, 'table', coords)}?${params}`,
      this.limiter
    )) as {
      code?: string;
      message?: string;
      durations?: (number | null)[][];
      distances?: (number | null)[][];
    };
    expectOk(data, 'table');
    return {
      durations: data.durations ?? [],
      distances: data.distances ?? [],
    };
  }

  async trip(
    profile: Profile,
    coords: LatLon[],
    roundtrip: boolean
  ): Promise<OsrmTrip> {
    const params = new URLSearchParams({
      overview: 'false',
      steps: 'false',
      roundtrip: roundtrip ? 'true' : 'false',
      source: 'first',
      ...(roundtrip ? {} : { destination: 'last' }),
    });
    const data = (await this.http.request(
      'osrm',
      `${this.url(profile, 'trip', coords)}?${params}`,
      this.limiter
    )) as {
      code?: string;
      message?: string;
      trips?: RawRoute[];
      waypoints?: Array<{ waypoint_index: number }>;
    };
    const trip = expectOk(data, 'trip').trips?.[0];
    if (!trip || !data.waypoints) throw new Error('OSRM returned no trip');
    // waypoints[i].waypoint_index is input i's position in the optimized tour;
    // invert it into "visit order" (order[k] = index of the k-th stop).
    const order = data.waypoints
      .map((wp, inputIndex) => ({ inputIndex, at: wp.waypoint_index }))
      .sort((a, b) => a.at - b.at)
      .map((entry) => entry.inputIndex);
    return {
      order,
      distanceMeters: trip.distance,
      durationSeconds: trip.duration,
      legs: toLegs(trip),
    };
  }
}

function expectOk<T extends { code?: string; message?: string }>(
  data: T,
  service: string
): T {
  if (data.code !== 'Ok') {
    throw new Error(
      `OSRM ${service} failed: ${data.code ?? 'unknown'}${data.message ? ` — ${data.message}` : ''}`
    );
  }
  return data;
}

function toLegs(route: RawRoute): OsrmLeg[] {
  return (route.legs ?? []).map((leg) => ({
    distanceMeters: leg.distance,
    durationSeconds: leg.duration,
    ...(leg.summary ? { summary: leg.summary } : {}),
  }));
}

function toSteps(route: RawRoute): OsrmStep[] {
  const steps: OsrmStep[] = [];
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      const kind = step.maneuver?.type ?? '';
      if (kind === 'arrive' && !step.name) continue;
      const direction = [step.maneuver?.type, step.maneuver?.modifier]
        .filter(Boolean)
        .join(' ');
      const name = step.name || '(unnamed road)';
      steps.push({
        instruction: direction ? `${direction} onto ${name}` : name,
        distanceMeters: step.distance,
      });
    }
  }
  return steps;
}
