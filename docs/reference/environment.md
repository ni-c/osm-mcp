# Environment variables

The complete set. **Every variable is optional** — the server works out of the
box against the free public OpenStreetMap services. There is no config file and
no command-line flag.

| Variable             | Required | Default                                                                                    | Description                                                                                          |
| -------------------- | -------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `OSM_USER_AGENT`     | no       | `osm-mcp/<version> (+https://github.com/ni-c/osm-mcp)`                                     | User-Agent sent to every service. Nominatim requires a real, identifying one.                        |
| `NOMINATIM_BASE_URL` | no       | `https://nominatim.openstreetmap.org`                                                      | Geocoding / reverse geocoding                                                                        |
| `PHOTON_BASE_URL`    | no       | `https://photon.komoot.io`                                                                 | Typo-tolerant geocoding                                                                              |
| `OSRM_BASE_URL`      | no       | `https://routing.openstreetmap.de`                                                         | Routing, matrices, trip optimization. Must serve the `routed-{car,bike,foot}` path prefixes (FOSSGIS layout). |
| `OVERPASS_BASE_URL`  | no       | `https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter`  | Comma-separated Overpass interpreter endpoints, tried in order on 429/5xx                            |
| `VALHALLA_BASE_URL`  | no       | `https://valhalla1.openstreetmap.de`                                                       | Isochrones                                                                                           |
| `ORS_API_KEY`        | no       | —                                                                                          | Optional [OpenRouteService](https://openrouteservice.org) key (secret). When set, routes, matrices and isochrones use ORS instead of OSRM/Valhalla. Free tier: 2 000 directions/day, 40/minute. |
| `ORS_BASE_URL`       | no       | `https://api.openrouteservice.org`                                                         | OpenRouteService endpoint                                                                            |
| `OSM_CACHE_TTL`      | no       | `3600`                                                                                     | Seconds identical upstream responses are served from the in-memory cache (`0` disables caching)      |

## Validation rules

Every `*_BASE_URL` value is validated at startup; the server exits with a
`ConfigError` when a rule is violated. Deliberately, the offending **value is
never echoed** in the error message — an API key pasted into the wrong variable
would otherwise be printed verbatim into the MCP host's log.

| Rule                                     | Behaviour                           |
| ---------------------------------------- | ----------------------------------- |
| Unparseable by `new URL()`               | Server exits with an error          |
| Scheme other than `http`/`https`         | Server exits with an error          |
| Contains `user:pass@`                    | Server exits with an error          |
| Contains a query string or fragment      | Server exits with an error          |
| Trailing slashes                         | Stripped                            |
| Plain `http` to a remote host            | Warning on stderr, server continues |
| Plain `http` to loopback                 | No warning                          |

Loopback means `localhost`, `*.localhost`, `127.*` or `::1` (IPv6 brackets are
stripped before matching).

Two more rules:

- `OSM_CACHE_TTL` must be a plain number of seconds; anything else exits.
- `ORS_BASE_URL` must be `https://` (or loopback) while `ORS_API_KEY` is set —
  the key travels in an `Authorization` header and would otherwise cross the
  network unencrypted.

## `ORS_API_KEY` handling

The only secret. It is **deleted from `process.env` immediately after
loading** — before any validation can throw — so it is not visible to child
processes or in `/proc/<pid>/environ` even if a caller catches the
`ConfigError` and keeps running. It is also redacted from error messages before
they reach the model context.

## Not configurable

| Behaviour                 | Value                       |
| ------------------------- | --------------------------- |
| Rate limit, per service   | ~1 request/second (ORS: ~40/minute) |
| Overpass concurrency      | 2 requests                  |
| Request timeout           | 30 s (Overpass: 40 s)       |
| HTTP redirects            | never followed              |
| Cache size                | 500 entries, ≤ 1 MB each    |
| Matrix size               | origins + destinations ≤ 25 |
| Turn-by-turn steps        | first 100                   |
| `poi_details` tag budget  | 60 tags, 500 chars per value |
