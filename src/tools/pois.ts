import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { categoryList, resolveCategory } from '../categories.js';
import type { Deps } from '../deps.js';
import {
  formatDistance,
  formatDuration,
  haversineMeters,
  roundCoord,
} from '../geo.js';
import type { Poi } from '../backends/overpass.js';
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

/** Tags worth showing in a list result; poi_details returns everything. */
const CORE_TAGS = [
  'amenity',
  'tourism',
  'shop',
  'leisure',
  'historic',
  'cuisine',
  'opening_hours',
  'website',
  'phone',
  'wheelchair',
] as const;

function coreTags(poi: Poi): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const key of CORE_TAGS) {
    const value = poi.tags[key];
    if (value) tags[key] = value;
  }
  return tags;
}

const OSM_ID = /^(node|way|relation)\/(\d{1,12})$/;

/** Response budget for poi_details: mega-relations carry hundreds of tags. */
const MAX_DETAIL_TAGS = 60;
const MAX_TAG_VALUE_LENGTH = 500;

function capTags(tags: Record<string, string>): {
  tags: Record<string, string>;
  tags_truncated?: string;
} {
  const entries = Object.entries(tags);
  const capped = Object.fromEntries(
    entries
      .slice(0, MAX_DETAIL_TAGS)
      .map(([key, value]) => [
        key,
        value.length > MAX_TAG_VALUE_LENGTH
          ? `${value.slice(0, MAX_TAG_VALUE_LENGTH)}… (truncated)`
          : value,
      ])
  );
  return {
    tags: capped,
    ...(entries.length > MAX_DETAIL_TAGS
      ? {
          tags_truncated: `showing ${MAX_DETAIL_TAGS} of ${entries.length} tags`,
        }
      : {}),
  };
}

export function registerPoiTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    'find_nearby_pois',
    {
      title: 'Find nearby places (POIs)',
      description:
        'Finds points of interest near a location, sorted by distance. ' +
        `Category shortcuts: ${categoryList()}. ` +
        'Any other OSM tag works as "key" or "key=value" (e.g. "diet:vegan=yes"). ' +
        'Use poi_details for the full record of one result.',
      inputSchema: {
        near: waypoint,
        category: z
          .string()
          .min(1)
          .max(100)
          .describe('Category shortcut or OSM tag filter'),
        radius_m: z
          .number()
          .int()
          .min(50)
          .max(10_000)
          .optional()
          .describe('Search radius in meters, default 1000'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe('Maximum number of results, default 10'),
        language,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ near, category, radius_m, limit, language }) =>
      run(async () => {
        const selector = resolveCategory(category);
        const center = await deps.resolver.resolve(near, language);
        const max = limit ?? 10;
        // Overpass's own limit is applied before sorting, so fetch a few more
        // and cut after sorting by distance.
        const pois = await deps.overpass.findNearby(
          center,
          selector,
          radius_m ?? 1000,
          Math.min(100, max * 4)
        );
        const sorted = pois
          .map((poi) => ({ poi, meters: haversineMeters(center, poi) }))
          .sort((a, b) => a.meters - b.meters)
          .slice(0, max);
        return untrustedResult({
          near: center.label,
          category,
          count: sorted.length,
          ...(sorted.length === 0
            ? {
                note: 'Nothing found — try a larger radius_m or another category.',
              }
            : {}),
          results: sorted.map(({ poi, meters }) => ({
            name: poi.name,
            distance: formatDistance(meters),
            lat: poi.lat,
            lon: poi.lon,
            osm: poi.osm,
            ...coreTags(poi),
          })),
        });
      })
  );

  server.registerTool(
    'poi_details',
    {
      title: 'Get POI details',
      description:
        'Fetches the full OpenStreetMap record of one element — all tags ' +
        '(opening hours, website, phone, …), coordinates and a map link. ' +
        'Takes an OSM id as returned by find_nearby_pois or geocode, ' +
        'e.g. "node/240109189".',
      inputSchema: {
        osm_id: z
          .string()
          .regex(OSM_ID, 'expected "node/<id>", "way/<id>" or "relation/<id>"'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ osm_id }) =>
      run(async () => {
        const [, type, id] = OSM_ID.exec(osm_id)!;
        const element = await deps.overpass.byId(
          type as 'node' | 'way' | 'relation',
          Number(id)
        );
        if (!element) {
          throw new Error(`no OSM element found for ${osm_id}`);
        }
        const lat = element.lat ?? element.center?.lat;
        const lon = element.lon ?? element.center?.lon;
        return untrustedResult({
          osm: osm_id,
          name: element.tags?.name ?? '(unnamed)',
          ...(lat !== undefined && lon !== undefined
            ? {
                lat: roundCoord(lat),
                lon: roundCoord(lon),
                map: `https://www.openstreetmap.org/${osm_id}`,
              }
            : {}),
          ...capTags(element.tags ?? {}),
        });
      })
  );

  server.registerTool(
    'suggest_meeting_point',
    {
      title: 'Suggest a meeting point',
      description:
        'Suggests a fair place to meet for people starting from different ' +
        'locations: finds venues around the geographic midpoint and picks the ' +
        'one with the most balanced travel times for everyone.',
      inputSchema: {
        locations: z
          .array(waypoint)
          .min(2)
          .max(8)
          .describe('Starting points of all participants'),
        profile: z
          .enum(['foot', 'car', 'bike'])
          .optional()
          .describe('How everyone travels, default foot'),
        venue_category: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe('What kind of venue to meet at, default "cafe"'),
        search_radius_m: z
          .number()
          .int()
          .min(100)
          .max(10_000)
          .optional()
          .describe('Venue search radius around the midpoint, default 1500'),
        language,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ locations, profile, venue_category, search_radius_m, language }) =>
      run(async () => {
        const mode = profile ?? 'foot';
        const selector = resolveCategory(venue_category ?? 'cafe');
        const origins = await deps.resolver.resolveAll(locations, language);
        const midpoint = {
          lat: origins.reduce((sum, p) => sum + p.lat, 0) / origins.length,
          lon: origins.reduce((sum, p) => sum + p.lon, 0) / origins.length,
        };
        const venues = (
          await deps.overpass.findNearby(
            midpoint,
            selector,
            search_radius_m ?? 1500,
            30
          )
        )
          .map((poi) => ({ poi, meters: haversineMeters(midpoint, poi) }))
          .sort((a, b) => a.meters - b.meters)
          .slice(0, 8)
          .map((entry) => entry.poi);
        if (venues.length === 0) {
          return untrustedResult({
            note:
              'No matching venue near the midpoint — try a larger ' +
              'search_radius_m or another venue_category.',
            midpoint: {
              lat: roundCoord(midpoint.lat),
              lon: roundCoord(midpoint.lon),
            },
          });
        }
        const engine = deps.ors.enabled ? deps.ors : deps.osrm;
        const matrix = await engine.table(mode, origins, venues);
        // Fairness first (smallest worst-case travel time), then total time.
        let best = 0;
        let bestScore = [Infinity, Infinity];
        for (let v = 0; v < venues.length; v++) {
          const times = origins.map((_, o) => matrix.durations[o]?.[v] ?? null);
          if (times.some((t) => t === null)) continue;
          const score = [
            Math.max(...(times as number[])),
            (times as number[]).reduce((a, b) => a + b, 0),
          ];
          if (
            score[0]! < bestScore[0]! ||
            (score[0] === bestScore[0] && score[1]! < bestScore[1]!)
          ) {
            best = v;
            bestScore = score;
          }
        }
        const venue = venues[best]!;
        return untrustedResult({
          profile: mode,
          suggestion: {
            name: venue.name,
            lat: venue.lat,
            lon: venue.lon,
            osm: venue.osm,
            ...coreTags(venue),
          },
          travel_times: origins.map((origin, o) => {
            const seconds = matrix.durations[o]?.[best];
            return {
              from: origin.label,
              duration: seconds != null ? formatDuration(seconds) : 'unknown',
            };
          }),
          alternatives: venues
            .filter((_, v) => v !== best)
            .slice(0, 3)
            .map((alt) => ({ name: alt.name, osm: alt.osm })),
        });
      })
  );
}
