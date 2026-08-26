/**
 * The tools this server can register, declared rather than discovered.
 *
 * Declared, because the tool filter has to answer "is this a name you have?"
 * *before* anything is registered — and in read-only mode the write tools are
 * never registered at all. Deriving the catalogue from what actually reached
 * `registerTool` would make `OSM_ALLOW_TOOLS=get_thing` report
 * "unknown tool" under `OSM_READ_ONLY=true`, which is the one answer that
 * is wrong.
 *
 * This is also the full tool surface, hard-coded on purpose: a tool that appears
 * or disappears by accident is a change to the server's contract and has to be a
 * deliberate edit here. `test/tool-filter.test.ts` asserts that these lists and
 * the tools the server really registers are the same set.
 */

/** Every tool. This server never writes, so there is no split to make. */
export const ALL_TOOLS_LIST = [
  'find_nearby_pois',
  'geocode',
  'isochrone',
  'map_link',
  'optimize_route',
  'poi_details',
  'reverse_geocode',
  'route',
  'route_matrix',
  'straight_line_distance',
  'suggest_meeting_point',
] as const;

/** Every tool, read-only mode aside. */
export const ALL_TOOLS: readonly string[] = [...ALL_TOOLS_LIST];

/**
 * What `OSM_ALLOW_TOOLS=essential` selects: where, what is near, how far, show me.
 *
 * 6 of 11. Left out on purpose: `route_matrix`, `optimize_route` and `isochrone` — specialist, expensive,
 * and the ones that push you onto an OpenRouteService key.
 */
export const ESSENTIAL_TOOLS: readonly string[] = [
  'geocode',
  'reverse_geocode',
  'find_nearby_pois',
  'poi_details',
  'route',
  'map_link',
];
