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
