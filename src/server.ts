import { McpServer } from '@modelcontextprotocol/server';
import { buildToolFilter, installToolFilter } from 'mcp-tool-allowlist';

import { ALL_TOOLS, ESSENTIAL_TOOLS } from './tools/catalogue.js';

import { NominatimBackend } from './backends/nominatim.js';
import { OrsBackend } from './backends/ors.js';
import { OsrmBackend } from './backends/osrm.js';
import { OverpassBackend } from './backends/overpass.js';
import { PhotonBackend } from './backends/photon.js';
import { ValhallaBackend } from './backends/valhalla.js';
import type { Config } from './config.js';
import type { Deps } from './deps.js';
import { HttpClient } from './http.js';
import { PlaceResolver } from './resolve.js';
import { registerSecret } from './result.js';
import { registerGeocodingTools } from './tools/geocoding.js';
import { registerMiscTools } from './tools/misc.js';
import { registerPoiTools } from './tools/pois.js';
import { registerRoutingTools } from './tools/routing.js';
import { packageVersion } from './version.js';

export function createServer(config: Config): McpServer {
  // Before anything is built: an unusable tool list should fail on the
  // way in, not leave a server running with tools quietly missing.
  const filter = buildToolFilter({
    allowTools: config.allowTools,
    denyTools: config.denyTools,
    catalogue: {
      all: ALL_TOOLS,
      essential: ESSENTIAL_TOOLS,
    },
    names: {
      allow: 'OSM_ALLOW_TOOLS',
      deny: 'OSM_DENY_TOOLS',
      server: 'osm-mcp',
    },
  });

  // Last line of defense: no tool result may ever contain the key verbatim,
  // no matter which upstream echoed it.
  registerSecret(config.orsApiKey);

  const http = new HttpClient(config.userAgent, config.cacheTtlMs);
  const nominatim = new NominatimBackend(http, config);
  const photon = new PhotonBackend(http, config);
  const deps: Deps = {
    config,
    nominatim,
    resolver: new PlaceResolver(nominatim, photon),
    osrm: new OsrmBackend(http, config),
    overpass: new OverpassBackend(http, config),
    valhalla: new ValhallaBackend(http, config),
    ors: new OrsBackend(http, config),
  };

  const server = new McpServer({
    name: 'osm-mcp',
    version: packageVersion(),
  });

  // Wraps server.registerTool, so it has to sit before the first
  // register call and does not care how they are organised.
  installToolFilter(server, filter);

  registerGeocodingTools(server, deps);
  registerRoutingTools(server, deps);
  registerPoiTools(server, deps);
  registerMiscTools(server, deps);

  return server;
}
