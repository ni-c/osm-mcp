import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

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

  registerGeocodingTools(server, deps);
  registerRoutingTools(server, deps);
  registerPoiTools(server, deps);
  registerMiscTools(server, deps);

  return server;
}
