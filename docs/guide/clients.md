# Connecting clients

Every snippet below runs the same stdio server. None of them needs any
environment variables — the public OpenStreetMap services are the default. Add
an `env` block only for the optional settings in
[Configuration](/guide/configuration).

## Claude Code

```sh
claude mcp add osm -- npx -y osm-mcp
```

Check it took:

```sh
claude mcp list
```

## Claude Desktop

`claude_desktop_config.json` — macOS
`~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`:

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

Restart Claude Desktop afterwards; it only reads the file at startup.

## Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.osm]
command = "npx"
args = ["-y", "osm-mcp"]
```

## MCP Inspector

```sh
npx @modelcontextprotocol/inspector npx -y osm-mcp
```

## Docker

The image is multi-arch (amd64 and arm64) and published with an SBOM and build
provenance:

```sh
docker run -i --rm ghcr.io/ni-c/osm-mcp
```

`-i` is not optional: the protocol runs over stdin and stdout. There is no port
to publish and no healthcheck, because the server does not listen for anything.

As an MCP server entry:

```json
{
  "mcpServers": {
    "osm": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "ghcr.io/ni-c/osm-mcp"]
    }
  }
}
```

If you use an OpenRouteService key, forward it by name instead of putting it on
the command line, where it would show up in `docker inspect` and the host's
process list:

```json
{
  "mcpServers": {
    "osm": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "ORS_API_KEY", "ghcr.io/ni-c/osm-mcp"],
      "env": { "ORS_API_KEY": "…" }
    }
  }
}
```

## Pinning a version

`npx -y osm-mcp` follows the `latest` tag. To pin:

```sh
npx -y osm-mcp@0.1.0
```

…or use the matching image tag, `ghcr.io/ni-c/osm-mcp:0.1.0`.

## Running it from a checkout

For development, or to run an unreleased change:

```sh
git clone https://github.com/ni-c/osm-mcp.git
cd osm-mcp
npm install && npm run build

node dist/index.js
```

`npm test` runs the unit tests with every upstream API mocked; `npm run smoke`
is the opt-in live test against the real public services — including the
assertion that foot routes are much slower than car routes.
