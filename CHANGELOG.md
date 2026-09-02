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

- Every tool declares an `outputSchema` and answers with `structuredContent`
  beside the text block. A client no longer has to parse prose to use a result.

  All eleven carry `untrusted: true` and `source: "openstreetmap"` as fields —
  there is no exception list, because OpenStreetMap is editable by anyone on
  earth and no tool here answers with anything else. A client that reads only
  the structured half would otherwise get a mapper's free text with no framing
  at all.

  What this server computes is described exactly; what comes out of OSM is
  described but left open. The tag namespace has no schema, and the SDK
  validates every result against the advertised one before it goes out — so a
  stricter shape would turn a mapper adding `payment:bitcoin` into a
  `poi_details` that fails outright.

### Fixed

- The control-character and BiDi stripping now runs over the structured value
  as well, key by key. It used to happen on the serialized JSON, which reached
  every string in it for free; a value handed over as `structuredContent` is
  not text, so the same pass has to walk the tree. Without it the two channels
  of one answer would have differed in exactly the characters this server
  strips on purpose, and the machine-readable one would have been the dirty
  half.

### Changed

- Runs on **MCP SDK 2.0**. Existing clients see the same protocol revision they
  always did; the change is the package layout behind it.

- The linter is **oxlint** instead of eslint plus typescript-eslint, which
  lifts the TypeScript ceiling: typescript-eslint pins `typescript` below 6.1,
  so this repository was held on TypeScript 6 by its linter rather than by its
  code.

- The tool filter, the host classifier and the documentation-asset generator
  now come from **`mcp-tool-allowlist`**, **`mcp-internal-hosts`** and
  **`svg-asset-set`** rather than from copies kept here — 674 fewer lines, and
  one place to fix each. None of them has a runtime dependency of its own.

- stdio is served through `serveStdio`, so the connection's era is negotiated
  on the opening exchange rather than assumed. A client that pins the
  `2026-07-28` era is served it; until now its `server/discover` probe was
  answered with "Method not found" and only `2025-11-25` was on offer. A client
  that speaks the older era sees no change — it is still pinned to one instance
  for the life of the connection, exactly as a hand-wired
  `StdioServerTransport` served it.

### Fixed

- **Control characters and BiDi overrides are stripped from every result.**
  OpenStreetMap is editable by anyone on earth, and a POI's `name`, Nominatim's
  `display_name` and the street names inside OSRM turn instructions are whatever
  a mapper typed. `JSON.stringify` escapes everything below U+0020 and nothing
  above it, so U+007F, the C1 block — which contains CSI at U+009B — and the
  BiDi overrides U+202A-U+202E reached the model verbatim. The error path had no
  JSON encoding at all: an upstream body is concatenated straight into the text
  block, and none of the default endpoints is run by this project.

  The filter sits in `textResult` and `errorResult`, the two funnels every
  result passes through, rather than at each field. U+200E and U+200F are
  deliberately **kept** in data: a right-to-left mark is legitimate in an OSM
  name and cannot reorder the text around it, so stripping it would corrupt the
  name of a real place. An upstream error body has no such name to protect and
  takes the full set, in `sanitizeErrorBody` as well as on the way out.

- **`isochrone` no longer fails with `Maximum call stack size exceeded`.** The
  bounding box was built with `Math.max(...lats)`, and argument spread puts every
  element on the call stack: about 125 000 points still work, 150 000 already
  throw. A 120-minute car isochrone from a Valhalla instance that does not
  generalize carries several hundred thousand points, well inside the 8 MB
  response cap — so the tool failed on a perfectly ordinary answer, with a
  message that told the model nothing and invited it to retry, each retry being
  another rate-limited upstream request. The box is now folded rather than
  spread, which makes the response size irrelevant to this path.

  The contour geometry also has an explicit ceiling now, like everything else
  unbounded here (100 route steps, 60 detail tags, 500 characters per tag value).
  It is set above what the response cap can carry at realistic coordinate
  precision, so a legitimate contour still comes back whole, and reaching it is
  an error naming a smaller budget rather than a silent truncation — a bounding
  box computed from the first half of a ring would be a wrong answer, which is
  worse than the error it replaced.

- An entry in `OSM_ALLOW_TOOLS` that is not tool-name-shaped is now
  **redacted** in the error rather than quoted back. a value pasted into the
  wrong variable is no longer echoed into the client's log.

## [0.2.0] - 2026-08-27

### Added

- `OSM_ALLOW_TOOLS` and `OSM_DENY_TOOLS` choose which of the 11
  tools are registered. Both take comma-separated tool names or a prefix with a
  trailing `*`, the allow list decides what is in and the deny list is subtracted
  from it, and `OSM_ALLOW_TOOLS=essential` selects a curated six —
  `geocode`, `reverse_geocode`, `find_nearby_pois`, `poi_details`, `route`, `map_link`. A model picks the right tool far more reliably from six than
  from eleven, and every visible tool costs context on every request. Nothing
  changes for an installation that sets neither.

  A filtered tool is not registered at all, so it is absent from `tools/list`
  and answers `tools/call` with "tool not found".

  An entry that matches no tool **stops the server at startup**, naming the
  entry and listing the real names, rather than being ignored: an ignored typo
  leaves a tool missing from `tools/list` with nothing pointing at the cause.

### Changed

- The README now carries the same eight badges, in the same order, as every other
  MCP server in this family, all of them reading from npm rather than hard-coded;
  the opening follows one shape; and the standalone "Full documentation" line is
  gone, because the docs badge three lines above it points at the same page.

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
