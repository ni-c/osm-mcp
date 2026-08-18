# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

<!-- The docs site includes everything between these markers. Keep the end marker
     last in the file so the link definitions come along. -->
<!-- #region changelog -->

## [Unreleased]

### Fixed

- The optional `ORS_API_KEY` is now removed from the environment before any
  configuration validation can throw. Previously a caller that caught the
  `ConfigError` (e.g. for an invalid `OSM_CACHE_TTL`) would keep running with
  the key still in `process.env` — readable in `/proc/<pid>/environ` and
  inherited by child processes. (Same finding as audiobookshelf-mcp PR #2.)
- Invalid base-URL and `OSM_CACHE_TTL` values are no longer echoed in error
  messages — an API key pasted into the wrong environment variable would have
  been printed verbatim into the MCP host's log.
- `isLoopbackHost` now strips IPv6 brackets generically instead of matching
  only the literal `[::1]`.

### Added

- Initial implementation: 11 read-only OpenStreetMap tools — geocoding
  (Nominatim + Photon), routing/matrix/trip optimization via the FOSSGIS OSRM
  instance with correct `routed-{car,bike,foot}` profile prefixes, isochrones
  via Valhalla (OpenRouteService optional via `ORS_API_KEY`), POI search and
  details via Overpass with mirror failover, plus offline straight-line
  distance and openstreetmap.org link tools.
- Per-service rate limiting, in-memory response caching and a mandatory
  identifying User-Agent, keeping the server inside the published usage
  policies of the public OSM services.

<!-- #endregion changelog -->
