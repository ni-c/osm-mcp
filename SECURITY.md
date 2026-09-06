# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ni-c/osm-mcp/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include real
credentials, tokens, hostnames or private configuration in a report.

You can expect an initial response within a week. Fixed vulnerabilities are published
as a new release with a note in the CHANGELOG.

## Supported versions

Only the latest release and the current `main` branch receive security fixes.

## Trust model

This server holds **no credentials by default** — it talks to public, read-only
OpenStreetMap services. All tools are read-only; the server cannot modify
OpenStreetMap data. The only optional secret is `ORS_API_KEY`, an
OpenRouteService key: compromising it lets an attacker consume the key owner's
free-tier request quota, nothing more. The key is removed from the process
environment after loading and redacted from error messages.

The MCP client process, and therefore the model driving it, sees every tool
result. Data returned from the OSM services is user-contributed and therefore
untrusted input: tool results carrying it are explicitly marked as data, not
instructions, and upstream error bodies are truncated (HTML pages dropped)
before they reach the model context.

## The queries leave the house

This is the property that separates this server from the rest of the family:
almost all of them talk to one instance the operator runs. This one talks to
**six public services** by default — Nominatim, Photon, OSRM, Overpass, Valhalla
and optionally OpenRouteService — and every question reaches whoever runs them.

A geocoding query is not neutral text. "Where is <street>, <town>" is where
somebody intends to be, and a route request is where they intend to go from and
to. Each of the six operators sees that, keeps whatever logs they keep, and is
under no obligation to this project. Do not send a location through this server
that you would not put into a stranger's web form.

Every `*_BASE_URL` can be pointed at a self-hosted instance, which is the answer
for anything sensitive: the tools behave the same, the queries stay in the
building.

## Pointing the base URLs somewhere else

That configurability is also the server's largest attack surface, so it is
worth being precise about what is and is not checked.

- `ORS_BASE_URL` must be `https://` whenever `ORS_API_KEY` is set. The server
  refuses to start otherwise rather than sending the key in the clear.
- Loopback addresses are recognised through `mcp-internal-hosts` — the same
  classifier the SSRF guards in this family use — so a locally hosted backend is
  not mistaken for a remote one written in an unusual form (`[::1]`,
  `::ffff:127.0.0.1`).
- Beyond that, a base URL is trusted: whoever sets the environment of this
  process has already chosen where it may talk. The variables are not tool
  parameters and a model cannot change them.

## Usage policies are part of the arrangement

The public endpoints are donated infrastructure with published usage policies,
and this server is built to keep them rather than to be polite about them: it
sends an identifying `User-Agent`, caches identical requests for a configurable
TTL, and throttles per service through a queue that refuses work rather than
growing without bound.

None of that is decoration. A server that ignores the policies gets the whole
IP range blocked, which is a denial of service against everyone else using it.
