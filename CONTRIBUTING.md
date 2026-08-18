# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/osm-mcp.git && cd osm-mcp
npm install
npm test          # unit tests, all upstream APIs mocked — no network needed
npm run build
```

A minimal dev environment:

```sh
npm run build && node dist/index.js   # starts the stdio server with public defaults
npm run smoke                         # opt-in LIVE test against the real services
```

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change.
  CI runs lint, build and the mocked test suite on the two current Node LTS lines.
- **Comments** explain constraints the code cannot show — not what the next line does.
- **Security-sensitive areas** (config parsing, Overpass QL construction, anything
  that builds a request URL): please describe the attack you are defending against,
  or the one your change might open, in the PR text.
- **Respect the public services.** Changes must not weaken the rate limiting,
  caching or the identifying User-Agent — these keep the server inside the
  usage policies of Nominatim, OSRM, Overpass, Valhalla and Photon.
- **No new runtime dependencies** without a very good reason; the small tree is a
  feature.
- Run `npm run lint` before pushing — it checks both eslint and prettier, and prettier
  also validates the YAML, JSON and Markdown files.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/osm-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/osm-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/osm-mcp/security/advisories/new)
