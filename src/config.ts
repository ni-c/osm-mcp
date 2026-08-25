import { internalHostKind } from './hosts.js';
import { packageVersion } from './version.js';

export interface Config {
  /** User-Agent sent to every upstream service. Nominatim requires a real one. */
  userAgent: string;
  nominatimUrl: string;
  photonUrl: string;
  /**
   * FOSSGIS OSRM instance. Profiles are selected via the `routed-car` /
   * `routed-bike` / `routed-foot` path prefixes on this host — the profile
   * segment inside the OSRM path itself is ignored by the demo servers.
   */
  osrmUrl: string;
  /** Overpass interpreter endpoints, tried in order on 429/5xx. */
  overpassUrls: string[];
  valhallaUrl: string;
  orsUrl: string;
  /** Optional OpenRouteService key; routing/matrix/isochrones switch to ORS when set. */
  orsApiKey: string | undefined;
  /** How long identical upstream responses are served from the in-memory cache. */
  cacheTtlMs: number;
}

export class ConfigError extends Error {}

const DEFAULTS = {
  NOMINATIM_BASE_URL: 'https://nominatim.openstreetmap.org',
  PHOTON_BASE_URL: 'https://photon.komoot.io',
  OSRM_BASE_URL: 'https://routing.openstreetmap.de',
  OVERPASS_BASE_URL:
    'https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter',
  VALHALLA_BASE_URL: 'https://valhalla1.openstreetmap.de',
  ORS_BASE_URL: 'https://api.openrouteservice.org',
} as const;

/**
 * Reads the configuration from environment variables. Every variable has a
 * public default, so the server starts (and all tools work) with an empty
 * environment. Only `ORS_API_KEY` is a secret; it is removed from the
 * environment after loading so it is not visible to child processes or in
 * /proc/<pid>/environ.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Don't keep the key in the environment for the process lifetime — it is
  // visible to child processes and in /proc/<pid>/environ. This happens before
  // any branch on purpose: every validation below can throw, and a caller that
  // catches the ConfigError would otherwise keep running with the key still
  // sitting in the environment. Everything after this point reads the local.
  const orsApiKey = env.ORS_API_KEY;
  delete env.ORS_API_KEY;

  const userAgent =
    env.OSM_USER_AGENT ??
    `osm-mcp/${packageVersion()} (+https://github.com/ni-c/osm-mcp)`;

  const cacheTtlSeconds = env.OSM_CACHE_TTL ?? '3600';
  if (!/^\d+$/.test(cacheTtlSeconds)) {
    throw new ConfigError('OSM_CACHE_TTL must be a number of seconds');
  }

  // The key travels in an Authorization header — never over cleartext http
  // to a non-local host.
  const orsUrl = baseUrl(env, 'ORS_BASE_URL');
  if (orsApiKey && isCleartextRemote(orsUrl)) {
    throw new ConfigError(
      'ORS_BASE_URL must use https:// when ORS_API_KEY is set — the key would be sent unencrypted'
    );
  }

  return {
    userAgent,
    nominatimUrl: baseUrl(env, 'NOMINATIM_BASE_URL'),
    photonUrl: baseUrl(env, 'PHOTON_BASE_URL'),
    osrmUrl: baseUrl(env, 'OSRM_BASE_URL'),
    overpassUrls: (env.OVERPASS_BASE_URL ?? DEFAULTS.OVERPASS_BASE_URL)
      .split(',')
      .map((url) => url.trim())
      .filter((url) => url.length > 0)
      .map((url) => validateUrl('OVERPASS_BASE_URL', url)),
    valhallaUrl: baseUrl(env, 'VALHALLA_BASE_URL'),
    orsUrl,
    orsApiKey,
    cacheTtlMs: Number(cacheTtlSeconds) * 1000,
  };
}

function baseUrl(env: NodeJS.ProcessEnv, name: keyof typeof DEFAULTS): string {
  return validateUrl(name, env[name] ?? DEFAULTS[name]);
}

function validateUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // The value itself is not echoed: this branch fires precisely when the
    // variable does not hold what was expected, and an API key pasted into the
    // wrong environment variable would otherwise be printed verbatim into the
    // MCP host's log.
    throw new ConfigError(
      `${name} is not a valid URL (e.g. https://example.com)`
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(
      `${name} must use http:// or https:// (got ${parsed.protocol})`
    );
  }
  // Credentials embedded in a URL would end up in logs and error messages.
  if (parsed.username || parsed.password) {
    throw new ConfigError(`${name} must not contain credentials`);
  }
  // A query string or fragment on a base URL produces malformed request URLs
  // (params get appended after it) and could smuggle a token into error output.
  if (parsed.search || parsed.hash) {
    throw new ConfigError(
      `${name} must be a plain base URL without a query string or fragment`
    );
  }
  if (isCleartextRemote(value)) {
    console.error(
      `osm-mcp: WARNING: ${name} uses plain http to a non-local host — requests travel unencrypted`
    );
  }
  // Return the parsed URL, not the raw input: the WHATWG parser has already
  // stripped whitespace and normalized the host during validation, and the
  // value used downstream should be exactly the value that was validated.
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

function isCleartextRemote(url: string): boolean {
  const parsed = new URL(url);
  return parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname);
}

function isLoopbackHost(hostname: string): boolean {
  // The shared classifier, so every spelling of a loopback address is
  // recognised — including http://[::ffff:127.0.0.1] and 'localhost.' with its
  // root label, which the string comparison this replaced did not see.
  return internalHostKind(hostname) === 'loopback';
}
