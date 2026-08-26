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

- The container image no longer ships OpenSSL 3.5.7-r0, which carries
  **CVE-2026-14456** (denial of service via unbounded memory growth). The pinned
  `node:24-alpine` digest is already the newest one; Alpine's fixed 3.5.8-r0 has
  simply not been rebuilt into it yet, so the runtime stage now upgrades
  `libcrypto3` and `libssl3` by name. Upgrading those two rather than running a
  blanket `apk upgrade` keeps the rest of the image exactly as the digest pins
  it. The step can go once the base image ships the fix.

## [0.1.2] - 2026-08-26

### Changed

- The check that decides whether a configured endpoint is local — and therefore
  whether sending an API key over plain `http` is worth warning about — now uses
  the same host classifier as the other MCP servers in this family, in
  `src/hosts.ts`. The string comparison it replaces missed several spellings of
  the same address: `http://[::ffff:127.0.0.1]`, which `URL` canonicalises to
  `[::ffff:7f00:1]` before any check sees it, and `localhost.` with its root
  label. It also treated `127.example.com` as loopback, because it matched on the
  `127.` prefix, and so stayed quiet about a plain-http URL to a public host.

Nothing else changes: every endpoint this server talks to comes from the
environment, and no tool takes a URL, so there is no request whose target a
caller can choose.

## [0.1.1] - 2026-08-18

### Added

- Documentation site at <https://osm-mcp.ni-c.de>: guides, a complete tool
  reference generated from the actual schemas, FAQ and this changelog.
- Architecture diagram and demo recording, each generated from a single
  source (`npm run assets`, `docs/demo.tape`) and verified in CI.
- Fully automated release pipeline: npm publishing with provenance via
  Trusted Publishing, GitHub releases from the changelog, MCP Registry and
  multi-arch GHCR publishing on tag push.

## [0.1.0] - 2026-08-18

### Security

- The optional `ORS_API_KEY` is now stripped from every tool result as a last
  line of defense: it travels in an `Authorization` header, so an upstream (or
  a misconfigured `ORS_BASE_URL` host) echoing the request could previously
  have leaked it into the model context through an error body. URL-style key
  parameters are additionally redacted from sanitized error bodies.
- The `mcp-publisher` binary in the release workflows is now version-pinned and
  checksum-verified instead of floating on `releases/latest` — it runs with the
  job's OIDC identity, which proves registry ownership.
- The npm/registry publish in `release.yml` now waits for its own Trivy
  container scan instead of racing the scan in `ci.yml`.
- The response cache now has an aggregate 32 MB byte budget on top of the entry
  cap; the caps alone allowed ~500 MB of retained upstream JSON.
- Every tool call gets a 120 s wall-clock deadline: many-waypoint requests
  behind the 1 req/s geocoding limiter could previously occupy the queue for
  minutes past any client timeout.
- POI core tags are truncated with the same 500-char value budget as
  `poi_details` tags, and `countrycodes` input length is bounded.

### Fixed

- Validated base URLs are returned in their WHATWG-normalized form instead of
  the raw input string.
- The container now exits promptly on SIGTERM/SIGINT — as PID 1, Node gets no
  default signal handling, so `docker stop` used to wait out its grace period
  and SIGKILL.

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
