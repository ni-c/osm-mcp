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

Location queries are sent to the configured public services — do not use this
server for locations you would not put in a third-party web request. Point the
`*_BASE_URL` variables at self-hosted instances for sensitive use.
