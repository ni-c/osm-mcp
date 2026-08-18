import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Deps } from '../deps.js';
import { formatDistance, formatDuration, haversineMeters } from '../geo.js';
import type { OsrmLeg } from '../backends/osrm.js';
import type { Place } from '../resolve.js';
import { run, untrustedResult } from '../result.js';

const profile = z
  .enum(['foot', 'car', 'bike'])
  .describe('Travel mode: on foot, by car or by bicycle');

const waypoint = z
  .string()
  .min(1)
  .max(300)
  .describe('Place name, address, or coordinates as "lat,lon"');

const language = z
  .string()
  .regex(/^[a-zA-Z-]{2,10}$/)
  .optional()
  .describe('Language for resolved place labels, default "en"');

/** The FOSSGIS demo server asks for light use — keep matrices small. */
const MAX_MATRIX_LOCATIONS = 25;

/** Response budget: a continental route has tens of thousands of steps. */
const MAX_STEPS = 100;

function legSummaries(places: Place[], legs: OsrmLeg[]): unknown[] {
  return legs.map((leg, i) => ({
    from: places[i]?.label,
    to: places[i + 1]?.label,
    distance: formatDistance(leg.distanceMeters),
    duration: formatDuration(leg.durationSeconds),
    ...(leg.summary ? { via: leg.summary } : {}),
  }));
}

export function registerRoutingTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    'route',
    {
      title: 'Route between places',
      description:
        'Calculates the real-world travel distance and time between two or more ' +
        'places, walking, driving or cycling, on OpenStreetMap data. Waypoints ' +
        'are visited in the given order. Set include_steps for a turn-by-turn ' +
        'summary. Use route_matrix to compare many pairs, optimize_route to ' +
        'reorder stops.',
      inputSchema: {
        waypoints: z
          .array(waypoint)
          .min(2)
          .max(25)
          .describe('Start, optional stops in between, destination'),
        profile,
        include_steps: z
          .boolean()
          .optional()
          .describe('Include a turn-by-turn step summary, default false'),
        language,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ waypoints, profile, include_steps, language }) =>
      run(async () => {
        const places = await deps.resolver.resolveAll(waypoints, language);
        const engine = deps.ors.enabled ? deps.ors : deps.osrm;
        const result = await engine.route(
          profile,
          places,
          include_steps ?? false
        );
        return untrustedResult({
          profile,
          engine: deps.ors.enabled ? 'openrouteservice' : 'osrm',
          waypoints: places.map((p) => p.label),
          distance: formatDistance(result.distanceMeters),
          distance_m: Math.round(result.distanceMeters),
          duration: formatDuration(result.durationSeconds),
          duration_s: Math.round(result.durationSeconds),
          ...(places.length > 2
            ? { legs: legSummaries(places, result.legs) }
            : {}),
          ...(result.steps
            ? {
                steps: result.steps.slice(0, MAX_STEPS).map((step) => ({
                  instruction: step.instruction,
                  distance: formatDistance(step.distanceMeters),
                })),
                ...(result.steps.length > MAX_STEPS
                  ? {
                      steps_truncated: `showing the first ${MAX_STEPS} of ${result.steps.length} steps — route a shorter segment for full detail`,
                    }
                  : {}),
              }
            : {}),
        });
      })
  );

  server.registerTool(
    'route_matrix',
    {
      title: 'Travel time/distance matrix',
      description:
        'Computes travel times and distances from every origin to every ' +
        'destination in one call — ideal for comparing options (e.g. 5 hotels ' +
        'against 3 sights). Cells are null where no route exists.',
      inputSchema: {
        origins: z.array(waypoint).min(1).max(12),
        destinations: z.array(waypoint).min(1).max(12),
        profile,
        language,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ origins, destinations, profile, language }) =>
      run(async () => {
        if (origins.length + destinations.length > MAX_MATRIX_LOCATIONS) {
          throw new Error(
            `too many locations: origins + destinations must be <= ${MAX_MATRIX_LOCATIONS} ` +
              'to stay within the public OSRM usage policy'
          );
        }
        const from = await deps.resolver.resolveAll(origins, language);
        const to = await deps.resolver.resolveAll(destinations, language);
        const engine = deps.ors.enabled ? deps.ors : deps.osrm;
        const matrix = await engine.table(profile, from, to);
        return untrustedResult({
          profile,
          engine: deps.ors.enabled ? 'openrouteservice' : 'osrm',
          origins: from.map((p) => p.label),
          destinations: to.map((p) => p.label),
          durations_minutes: matrix.durations.map((row) =>
            row.map((s) => (s === null ? null : Math.round(s / 6) / 10))
          ),
          distances_km: matrix.distances.map((row) =>
            row.map((m) => (m === null ? null : Math.round(m / 10) / 100))
          ),
        });
      })
  );

  server.registerTool(
    'optimize_route',
    {
      title: 'Optimize stop order',
      description:
        'Finds the best order to visit a set of stops (traveling-salesman ' +
        'optimization) and returns the optimized itinerary with total distance ' +
        'and time. With roundtrip (default) the tour returns to the first stop; ' +
        'without it the first stop is the start and the last stop the end.',
      inputSchema: {
        stops: z.array(waypoint).min(3).max(12),
        profile,
        roundtrip: z
          .boolean()
          .optional()
          .describe('Return to the first stop at the end, default true'),
        language,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ stops, profile, roundtrip, language }) =>
      run(async () => {
        const places = await deps.resolver.resolveAll(stops, language);
        // The OSRM /trip service does this natively; ORS has no equivalent in
        // its core API, so this tool always uses OSRM.
        const trip = await deps.osrm.trip(profile, places, roundtrip ?? true);
        const ordered = trip.order.map((i) => places[i]!);
        const orderedLabels = ordered.map((p) => p.label);
        if (roundtrip ?? true)
          orderedLabels.push(`${ordered[0]!.label} (back to start)`);
        return untrustedResult({
          profile,
          engine: 'osrm',
          optimized_order: orderedLabels,
          distance: formatDistance(trip.distanceMeters),
          duration: formatDuration(trip.durationSeconds),
          legs: trip.legs.map((leg, i) => ({
            from: orderedLabels[i],
            to: orderedLabels[i + 1],
            distance: formatDistance(leg.distanceMeters),
            duration: formatDuration(leg.durationSeconds),
          })),
        });
      })
  );

  server.registerTool(
    'isochrone',
    {
      title: 'Reachable area (isochrone)',
      description:
        'Shows how far you can get from a place within a time or distance ' +
        'budget ("what is reachable in 15 minutes on foot?"). Returns a compact ' +
        'summary of the reachable area: bounding box and reach per compass ' +
        'direction. Give exactly one of minutes or kilometers.',
      inputSchema: {
        center: waypoint,
        profile,
        minutes: z.number().min(1).max(120).optional(),
        kilometers: z.number().min(0.1).max(100).optional(),
        language,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ center, profile, minutes, kilometers, language }) =>
      run(async () => {
        if ((minutes === undefined) === (kilometers === undefined)) {
          throw new Error('give exactly one of "minutes" or "kilometers"');
        }
        const place = await deps.resolver.resolve(center, language);
        const engine = deps.ors.enabled ? deps.ors : deps.valhalla;
        const contours = await engine.isochrone(place, profile, {
          ...(minutes !== undefined ? { minutes } : {}),
          ...(kilometers !== undefined ? { kilometers } : {}),
        });
        const contour = contours[0];
        if (!contour || contour.coordinates.length === 0) {
          throw new Error('the isochrone service returned no contour');
        }
        const lats = contour.coordinates.map((c) => c.lat);
        const lons = contour.coordinates.map((c) => c.lon);
        const north = Math.max(...lats);
        const south = Math.min(...lats);
        const east = Math.max(...lons);
        const west = Math.min(...lons);
        return untrustedResult({
          center: place.label,
          profile,
          engine: deps.ors.enabled ? 'openrouteservice' : 'valhalla',
          budget: minutes !== undefined ? `${minutes} min` : `${kilometers} km`,
          bounding_box: { north, south, east, west },
          reach: {
            north: formatDistance(
              haversineMeters(place, { lat: north, lon: place.lon })
            ),
            south: formatDistance(
              haversineMeters(place, { lat: south, lon: place.lon })
            ),
            east: formatDistance(
              haversineMeters(place, { lat: place.lat, lon: east })
            ),
            west: formatDistance(
              haversineMeters(place, { lat: place.lat, lon: west })
            ),
          },
        });
      })
  );
}
