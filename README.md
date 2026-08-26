# osm-mcp

[![CI](https://img.shields.io/github/actions/workflow/status/ni-c/osm-mcp/ci.yml?branch=main&label=CI)](https://github.com/ni-c/osm-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/osm-mcp)](https://www.npmjs.com/package/osm-mcp)
[![npm downloads](https://img.shields.io/npm/dm/osm-mcp)](https://www.npmjs.com/package/osm-mcp)
[![node](https://img.shields.io/node/v/osm-mcp)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/osm-mcp)](LICENSE)
[![container](https://img.shields.io/badge/ghcr.io-ni--c%2Fosm--mcp-blue)](https://github.com/ni-c/osm-mcp/pkgs/container/osm-mcp)
[![docs](https://img.shields.io/badge/docs-osm--mcp.ni--c.de-informational)](https://osm-mcp.ni-c.de)
[![sponsor](https://img.shields.io/badge/sponsor-ni--c-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/ni-c)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
[OpenStreetMap](https://www.openstreetmap.org), built for travel planning.

Lets MCP clients like Claude Code, Claude Desktop or Codex answer questions about
places: geocoding, walking, driving and cycling distances and durations, multi-stop
route optimization, isochrones and POI search — 11 tools, all read-only.

All backends are free public OpenStreetMap services, so **no API key is required**.
An OpenRouteService key can be supplied optionally to switch the routing engine.

<!-- <picture> is resolved against the colour scheme of the page showing it, so GitHub
     picks the variant that matches its own theme toggle. npm strips <picture> and
     <source> when it sanitises the README and keeps the <img>, which is why that
     fallback brings its own dark card instead of relying on a media query. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://osm-mcp.ni-c.de/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://osm-mcp.ni-c.de/architecture-light.svg">
  <img src="https://osm-mcp.ni-c.de/architecture.svg" alt="An MCP client talks to osm-mcp over stdio; the server exposes eleven read-only tools with rate limiting and caching, and calls Nominatim, Photon, OSRM, Valhalla and Overpass over HTTPS — plus OpenRouteService optionally with an API key" width="800">
</picture>

<img src="https://osm-mcp.ni-c.de/demo.gif" alt="Terminal recording: the server reports eleven tools, geocodes the Porta Nigra in Trier, and returns a walking route with distance and duration" width="800">

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

## Install

```sh
claude mcp add osm -- npx -y osm-mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "osm": {
      "command": "npx",
      "args": ["-y", "osm-mcp"]
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.osm]
command = "npx"
args = ["-y", "osm-mcp"]
```

Container (multi-arch, with SBOM and build provenance):

```sh
docker run -i --rm ghcr.io/ni-c/osm-mcp
```

`-i` is required — the protocol runs over stdin and stdout. There is no port to
publish. More client recipes are in the
[client guide](https://osm-mcp.ni-c.de/guide/clients).

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

Tag-driven, no manual publish step:

1. Move the `[Unreleased]` entries into a new `## [x.y.z] - YYYY-MM-DD` section in
   `CHANGELOG.md` and bump `package.json`.
2. `npm run lint && npm run build && npm run test:coverage`.
3. Commit, then a **signed annotated** tag: `git tag -s vx.y.z -m "vx.y.z"`.
4. `git push origin main vx.y.z`.

`release.yml` then runs the tests, publishes to npm with provenance via Trusted
Publishing (no token secret involved), creates the GitHub release from the
CHANGELOG section, and publishes to the
[MCP registry](https://registry.modelcontextprotocol.io) as
`io.github.ni-c/osm-mcp`. `ci.yml` pushes the multi-arch image to GHCR on the
same tag.

If the registry step fails, fix it on `main` and dispatch the
`Publish to MCP Registry` workflow — do **not** re-run the tag job, which would
check out the old tree.

## License

[MIT](LICENSE)
