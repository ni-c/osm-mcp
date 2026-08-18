import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.js';

function env(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...values } as NodeJS.ProcessEnv;
}

describe('loadConfig', () => {
  it('starts with public defaults and no key', () => {
    const config = loadConfig(env());
    expect(config.nominatimUrl).toBe('https://nominatim.openstreetmap.org');
    expect(config.photonUrl).toBe('https://photon.komoot.io');
    expect(config.osrmUrl).toBe('https://routing.openstreetmap.de');
    expect(config.valhallaUrl).toBe('https://valhalla1.openstreetmap.de');
    expect(config.overpassUrls).toEqual([
      'https://overpass-api.de/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
    ]);
    expect(config.orsApiKey).toBeUndefined();
    expect(config.cacheTtlMs).toBe(3_600_000);
    expect(config.userAgent).toMatch(/^osm-mcp\/\d+\.\d+\.\d+ \(\+https:/);
  });

  it('removes the ORS key from the environment after reading it', () => {
    const e = env({ ORS_API_KEY: 'secret' });
    const config = loadConfig(e);
    expect(config.orsApiKey).toBe('secret');
    expect(e.ORS_API_KEY).toBeUndefined();
  });

  it('accepts overrides and strips trailing slashes', () => {
    const config = loadConfig(
      env({
        OSRM_BASE_URL: 'https://osrm.internal.example//',
        OVERPASS_BASE_URL: 'https://a.example/api, https://b.example/api ,',
        OSM_USER_AGENT: 'my-agent/1.0',
        OSM_CACHE_TTL: '60',
      })
    );
    expect(config.osrmUrl).toBe('https://osrm.internal.example');
    expect(config.overpassUrls).toEqual([
      'https://a.example/api',
      'https://b.example/api',
    ]);
    expect(config.userAgent).toBe('my-agent/1.0');
    expect(config.cacheTtlMs).toBe(60_000);
  });

  it('rejects invalid URLs, non-http protocols and embedded credentials', () => {
    expect(() => loadConfig(env({ NOMINATIM_BASE_URL: 'not a url' }))).toThrow(
      ConfigError
    );
    expect(() =>
      loadConfig(env({ VALHALLA_BASE_URL: 'ftp://example.com' }))
    ).toThrow(/http/);
    expect(() =>
      loadConfig(env({ ORS_BASE_URL: 'https://user:pass@example.com' }))
    ).toThrow(/credentials/);
  });

  it('rejects a non-numeric cache TTL', () => {
    expect(() => loadConfig(env({ OSM_CACHE_TTL: 'soon' }))).toThrow(
      ConfigError
    );
  });
});

describe('audit regressions', () => {
  it('refuses to send the ORS key over cleartext http', () => {
    expect(() =>
      loadConfig(
        env({ ORS_API_KEY: 'k', ORS_BASE_URL: 'http://ors.example.com' })
      )
    ).toThrow(/https/);
    // http to loopback is fine (local ORS instance)
    const config = loadConfig(
      env({ ORS_API_KEY: 'k', ORS_BASE_URL: 'http://localhost:8080' })
    );
    expect(config.orsUrl).toBe('http://localhost:8080');
  });

  it('rejects base URLs carrying a query string or fragment', () => {
    expect(() =>
      loadConfig(env({ OSRM_BASE_URL: 'https://example.com/?key=x' }))
    ).toThrow(/query string/);
    expect(() =>
      loadConfig(env({ VALHALLA_BASE_URL: 'https://example.com/#frag' }))
    ).toThrow(/query string/);
  });
});
