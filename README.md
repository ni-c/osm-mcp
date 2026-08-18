# osm-mcp

MCP server for OpenStreetMap: geocoding, walking/driving/cycling distances and
durations, multi-stop route optimization, isochrones and POI search — built for
travel planning with AI assistants.

All backends are free public OpenStreetMap services; **no API key is required**.
An OpenRouteService key can be supplied optionally to switch the routing engine.

## Why another OSM MCP server?

- **Correct walking/cycling routes.** The public OSRM demo servers ignore the
  profile segment inside the OSRM URL path and always return **car** routes
  unless the FOSSGIS `routed-foot` / `routed-bike` / `routed-car` path prefixes
  are used. Most existing OSM MCP servers get this wrong and silently return
  driving times for walking queries. This server uses the prefixes and its live
  smoke test asserts that foot routes are much slower than car routes.
- **Policy-compliant by construction.** Per-service rate limiting (Nominatim and
  OSRM: 1 request/second), an identifying User-Agent on every request (required
  by the Nominatim usage policy), response caching, capped Overpass concurrency
  (2 slots) and automatic failover to an Overpass mirror on 429/5xx.
- **Photon support.** Optional typo-tolerant geocoding via komoot's Photon,
  which is designed for interactive use — a better fit for LLM-driven lookups
  than hammering Nominatim.

## Requirements

- Node.js ≥ 22
- Internet access to the public OpenStreetMap services (see table below)

## Configuration

Every variable is optional — the server works out of the box.

| Variable             | Default                                                                                   | Description                                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OSM_USER_AGENT`     | `osm-mcp/<version> (+https://github.com/ni-c/osm-mcp)`                                    | User-Agent sent to every service. Nominatim requires a real, identifying one.                                                                                                                  |
| `NOMINATIM_BASE_URL` | `https://nominatim.openstreetmap.org`                                                     | Geocoding / reverse geocoding                                                                                                                                                                  |
| `PHOTON_BASE_URL`    | `https://photon.komoot.io`                                                                | Typo-tolerant geocoding                                                                                                                                                                        |
| `OSRM_BASE_URL`      | `https://routing.openstreetmap.de`                                                        | Routing, matrices, trip optimization. Must serve the `routed-{car,bike,foot}` path prefixes (the FOSSGIS layout).                                                                              |
| `OVERPASS_BASE_URL`  | `https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter` | Comma-separated Overpass endpoints, tried in order on 429/5xx                                                                                                                                  |
| `VALHALLA_BASE_URL`  | `https://valhalla1.openstreetmap.de`                                                      | Isochrones                                                                                                                                                                                     |
| `ORS_API_KEY`        | –                                                                                         | Optional [OpenRouteService](https://openrouteservice.org) key (secret). When set, routes, matrices and isochrones use ORS instead of OSRM/Valhalla. Free tier: 2000 directions/day, 40/minute. |
| `ORS_BASE_URL`       | `https://api.openrouteservice.org`                                                        | OpenRouteService endpoint                                                                                                                                                                      |
| `OSM_CACHE_TTL`      | `3600`                                                                                    | Seconds identical upstream responses are served from the in-memory cache (`0` disables caching)                                                                                                |

## Installation

### Claude Code (local checkout, pre-release)

```sh
npm install && npm run build
claude mcp add osm -- node /path/to/osm-mcp/dist/index.js
```

Once published, `npx -y osm-mcp` replaces the local path.

### Claude Desktop

```json
{
  "mcpServers": {
    "osm": {
      "command": "node",
      "args": ["/path/to/osm-mcp/dist/index.js"]
    }
  }
}
```

## Tools

| Tool                     | Description                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `geocode`                | Place name/address → coordinates (Nominatim or Photon)                                         |
| `reverse_geocode`        | Coordinates → nearest address                                                                  |
| `route`                  | Distance and duration between 2+ waypoints, `foot`/`car`/`bike`; optional turn-by-turn summary |
| `route_matrix`           | Travel time/distance from every origin to every destination in one call                        |
| `optimize_route`         | Best visiting order for a set of stops (traveling-salesman, OSRM trip)                         |
| `isochrone`              | Reachable area within a time or distance budget (Valhalla, or ORS with key)                    |
| `find_nearby_pois`       | POIs around a location by category or raw OSM tag, sorted by distance (Overpass)               |
| `poi_details`            | Full OSM record of one element: opening hours, website, phone, …                               |
| `suggest_meeting_point`  | Fair meeting venue for 2–8 people (balanced travel times)                                      |
| `straight_line_distance` | Great-circle distance, computed offline                                                        |
| `map_link`               | openstreetmap.org marker / directions links, computed offline                                  |

Every place input accepts either a name/address (geocoded automatically) or
literal coordinates as `"lat,lon"`.

## Usage policies & attribution

This server talks to shared community infrastructure. It enforces the
published limits client-side, but the operator asks users to keep overall
usage light and non-commercial:

- **Data:** © [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors, licensed under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/).
- **Nominatim:** max 1 request/second, identifying User-Agent mandatory,
  results cached ([policy](https://operations.osmfoundation.org/policies/nominatim/)).
- **OSRM / Valhalla (FOSSGIS):** reasonable, non-commercial use; max 1
  request/second ([about](https://routing.openstreetmap.de/about.html)).
- **Overpass:** ~2 concurrent slots per IP, <10 000 queries/day
  ([wiki](https://wiki.openstreetmap.org/wiki/Overpass_API)).
- **Photon:** fair use ([photon.komoot.io](https://photon.komoot.io)).

For heavy or commercial use, self-host the services and point the
`*_BASE_URL` variables at your instances.

## Safety

- All tools are **read-only**; the server never writes to OpenStreetMap.
- No credentials are required; the optional `ORS_API_KEY` is removed from the
  process environment after loading and redacted from error messages.
- OSM-sourced content (names, addresses, tags) is marked as untrusted data in
  tool results so the model treats it as data, not instructions.
- Upstream error bodies are truncated and HTML error pages dropped before they
  reach the model context.
- Redirects are never followed; all requests time out.

## Development

```sh
npm install
npm run lint          # eslint + prettier
npm test              # unit tests (all upstream APIs mocked)
npm run test:coverage
npm run build
npm run smoke         # opt-in LIVE test against the real public services
```

## Releasing

Not yet published — the project is in its test phase. Publishing (npm via
Trusted Publishing, GHCR, MCP Registry, documentation site) follows once the
test phase is over.

## License

[MIT](LICENSE)
