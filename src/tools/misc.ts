import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Deps } from '../deps.js';
import { formatDistance, haversineMeters } from '../geo.js';
import { run, untrustedResult } from '../result.js';

const waypoint = z
  .string()
  .min(1)
  .max(300)
  .describe('Place name, address, or coordinates as "lat,lon"');

const language = z
  .string()
  .regex(/^[a-zA-Z-]{2,10}$/)
  .optional()
  .describe('Language used when geocoding place names, default "en"');

/** openstreetmap.org directions engines backed by the same FOSSGIS OSRM. */
const MAP_ENGINE: Record<string, string> = {
  foot: 'fossgis_osrm_foot',
  car: 'fossgis_osrm_car',
  bike: 'fossgis_osrm_bike',
};

export function registerMiscTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    'straight_line_distance',
    {
      title: 'Straight-line distance',
      description:
        'Great-circle ("as the crow flies") distance between two places. ' +
        'Instant and independent of any road network — use route for real ' +
        'travel distances.',
      inputSchema: {
        from: waypoint,
        to: waypoint,
        language,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ from, to, language }) =>
      run(async () => {
        const a = await deps.resolver.resolve(from, language);
        const b = await deps.resolver.resolve(to, language);
        const meters = haversineMeters(a, b);
        return untrustedResult({
          from: a.label,
          to: b.label,
          distance: formatDistance(meters),
          distance_m: Math.round(meters),
        });
      })
  );

  server.registerTool(
    'map_link',
    {
      title: 'Generate map links',
      description:
        'Generates openstreetmap.org links to open in a browser: a marker link ' +
        'for a single place, or a directions link when from and to are given. ' +
        'Provide either "place", or both "from" and "to".',
      inputSchema: {
        place: z.optional(waypoint).describe('Place for a marker link'),
        from: z.optional(waypoint).describe('Start for a directions link'),
        to: z.optional(waypoint).describe('Destination for a directions link'),
        profile: z
          .enum(['foot', 'car', 'bike'])
          .optional()
          .describe('Travel mode for the directions link, default foot'),
        language,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ place, from, to, profile, language }) =>
      run(async () => {
        if (place && !from && !to) {
          const p = await deps.resolver.resolve(place, language);
          return untrustedResult({
            place: p.label,
            marker: `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=17/${p.lat}/${p.lon}`,
          });
        }
        if (from && to && !place) {
          const a = await deps.resolver.resolve(from, language);
          const b = await deps.resolver.resolve(to, language);
          const engine = MAP_ENGINE[profile ?? 'foot']!;
          const route = encodeURIComponent(
            `${a.lat},${a.lon};${b.lat},${b.lon}`
          );
          return untrustedResult({
            from: a.label,
            to: b.label,
            profile: profile ?? 'foot',
            directions: `https://www.openstreetmap.org/directions?engine=${engine}&route=${route}`,
          });
        }
        throw new Error('provide either "place", or both "from" and "to"');
      })
  );
}
