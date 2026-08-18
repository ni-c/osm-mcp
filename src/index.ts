#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ConfigError, loadConfig } from './config.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`osm-mcp: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  // In a container Node runs as PID 1 and gets no default SIGTERM handling —
  // without this, `docker stop` waits out its grace period and SIGKILLs.
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));

  const server = createServer(config);
  // stdout belongs to the protocol; everything human-readable goes to stderr.
  await server.connect(new StdioServerTransport());
  console.error(
    `osm-mcp: connected — routing via ${
      config.orsApiKey
        ? 'OpenRouteService (ORS_API_KEY set)'
        : 'public OSRM/Valhalla'
    }`
  );
}

main().catch((error: unknown) => {
  console.error('osm-mcp: fatal error:', error);
  process.exit(1);
});
