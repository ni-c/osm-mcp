import { afterEach, describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

async function connect(env: Record<string, string> = {}): Promise<Client> {
  const server = createServer(loadConfig(env as NodeJS.ProcessEnv));
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init)
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content[0]?.text ?? '';
}

function parseJson<T>(result: Awaited<ReturnType<Client['callTool']>>): T {
  const text = firstText(result);
  return JSON.parse(text.slice(text.indexOf('{'))) as T;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('route', () => {
  it('geocodes waypoint names through Nominatim before routing', async () => {
    const urls: string[] = [];
    stubFetch((url) => {
      urls.push(url);
      if (url.includes('nominatim')) {
        return jsonResponse([
          { lat: '49.7596', lon: '6.6439', display_name: 'Trier, Germany' },
        ]);
      }
      return jsonResponse({
        code: 'Ok',
        routes: [{ distance: 44_000, duration: 2400, legs: [] }],
      });
    });
    const client = await connect();
    const result = await client.callTool({
      name: 'route',
      arguments: { waypoints: ['Trier', '49.6116,6.1319'], profile: 'car' },
    });
    expect(result.isError).toBeFalsy();
    expect(urls[0]).toContain('nominatim.openstreetmap.org/search');
    expect(urls[1]).toContain('/routed-car/');
    const data = parseJson<{ waypoints: string[] }>(result);
    expect(data.waypoints[0]).toBe('Trier, Germany');
  });

  it('fails with a clear message when a waypoint cannot be geocoded', async () => {
    stubFetch(() => jsonResponse([]));
    const client = await connect();
    const result = await client.callTool({
      name: 'route',
      arguments: {
        waypoints: ['Nowhereville-XYZ', '49.6,6.1'],
        profile: 'foot',
      },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('no location found');
  });

  it('returns turn-by-turn steps when requested', async () => {
    stubFetch(() =>
      jsonResponse({
        code: 'Ok',
        routes: [
          {
            distance: 1200,
            duration: 900,
            legs: [
              {
                distance: 1200,
                duration: 900,
                steps: [
                  {
                    distance: 700,
                    name: 'Simeonstraße',
                    maneuver: { type: 'depart' },
                  },
                  {
                    distance: 500,
                    name: 'Hauptmarkt',
                    maneuver: { type: 'turn', modifier: 'left' },
                  },
                  { distance: 0, name: '', maneuver: { type: 'arrive' } },
                ],
              },
            ],
          },
        ],
      })
    );
    const client = await connect();
    const result = await client.callTool({
      name: 'route',
      arguments: {
        waypoints: ['49.75,6.64', '49.76,6.65'],
        profile: 'foot',
        include_steps: true,
      },
    });
    const data = parseJson<{ steps: Array<{ instruction: string }> }>(result);
    expect(data.steps).toHaveLength(2);
    expect(data.steps[1]!.instruction).toBe('turn left onto Hauptmarkt');
  });

  it('adds a rate-limit hint on HTTP 429 from the routing service', async () => {
    stubFetch(() => new Response('rate limited', { status: 429 }));
    const client = await connect();
    const result = await client.callTool({
      name: 'route',
      arguments: { waypoints: ['49.75,6.64', '49.76,6.65'], profile: 'foot' },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('wait ~30 seconds');
  });
});

describe('route_matrix', () => {
  it('returns rounded minutes and kilometers', async () => {
    stubFetch(() =>
      jsonResponse({
        code: 'Ok',
        durations: [[600, null]],
        distances: [[1500, null]],
      })
    );
    const client = await connect();
    const result = await client.callTool({
      name: 'route_matrix',
      arguments: {
        origins: ['49.75,6.64'],
        destinations: ['49.76,6.65', '49.77,6.66'],
        profile: 'foot',
      },
    });
    const data = parseJson<{
      durations_minutes: (number | null)[][];
      distances_km: (number | null)[][];
    }>(result);
    expect(data.durations_minutes).toEqual([[10, null]]);
    expect(data.distances_km).toEqual([[1.5, null]]);
  });
});

describe('optimize_route', () => {
  it('returns the optimized visiting order with legs', async () => {
    const mock = stubFetch(() =>
      jsonResponse({
        code: 'Ok',
        trips: [
          {
            distance: 9000,
            duration: 7200,
            legs: [
              { distance: 3000, duration: 2400 },
              { distance: 3000, duration: 2400 },
              { distance: 3000, duration: 2400 },
            ],
          },
        ],
        waypoints: [
          { waypoint_index: 0 },
          { waypoint_index: 2 },
          { waypoint_index: 1 },
        ],
      })
    );
    const client = await connect();
    const result = await client.callTool({
      name: 'optimize_route',
      arguments: {
        stops: ['49.75,6.64', '49.76,6.65', '49.77,6.66'],
        profile: 'bike',
      },
    });
    const url = new URL(String(mock.mock.calls[0]![0]));
    expect(url.pathname).toContain('/routed-bike/trip/v1/driving/');
    expect(url.searchParams.get('roundtrip')).toBe('true');
    expect(url.searchParams.get('source')).toBe('first');
    const data = parseJson<{
      optimized_order: string[];
      legs: unknown[];
    }>(result);
    expect(data.optimized_order).toEqual([
      '49.75,6.64',
      '49.77,6.66',
      '49.76,6.65',
      '49.75,6.64 (back to start)',
    ]);
    expect(data.legs).toHaveLength(3);
  });
});

describe('isochrone', () => {
  it('summarizes a Valhalla contour as bounding box and reach', async () => {
    const mock = stubFetch(() =>
      jsonResponse({
        features: [
          {
            properties: { contour: 15 },
            geometry: {
              type: 'LineString',
              coordinates: [
                [6.62, 49.74],
                [6.66, 49.76],
                [6.64, 49.77],
              ],
            },
          },
        ],
      })
    );
    const client = await connect();
    const result = await client.callTool({
      name: 'isochrone',
      arguments: { center: '49.75,6.64', profile: 'foot', minutes: 15 },
    });
    expect(String(mock.mock.calls[0]![0])).toContain(
      'valhalla1.openstreetmap.de/isochrone'
    );
    const data = parseJson<{
      engine: string;
      budget: string;
      bounding_box: { north: number };
      reach: { north: string };
    }>(result);
    expect(data.engine).toBe('valhalla');
    expect(data.budget).toBe('15 min');
    expect(data.bounding_box.north).toBe(49.77);
    expect(data.reach.north).toMatch(/km|m/);
  });

  it('uses ORS isochrones when a key is configured', async () => {
    const mock = stubFetch(() =>
      jsonResponse({
        features: [
          {
            properties: { value: 900 },
            geometry: { coordinates: [[[6.62, 49.74]]] },
          },
        ],
      })
    );
    const client = await connect({ ORS_API_KEY: 'k' });
    const result = await client.callTool({
      name: 'isochrone',
      arguments: { center: '49.75,6.64', profile: 'car', kilometers: 5 },
    });
    expect(result.isError).toBeFalsy();
    const url = String(mock.mock.calls[0]![0]);
    expect(url).toContain('/v2/isochrones/driving-car');
    const data = parseJson<{ engine: string; budget: string }>(result);
    expect(data.engine).toBe('openrouteservice');
    expect(data.budget).toBe('5 km');
  });
});

describe('geocode', () => {
  it('uses Photon when requested', async () => {
    const mock = stubFetch(() =>
      jsonResponse({
        features: [
          {
            geometry: { coordinates: [6.64, 49.75] },
            properties: { name: 'Porta Nigra', city: 'Trier' },
          },
        ],
      })
    );
    const client = await connect();
    const result = await client.callTool({
      name: 'geocode',
      arguments: { query: 'porta ngira', provider: 'photon' },
    });
    expect(String(mock.mock.calls[0]![0])).toContain('photon.komoot.io/api');
    const data = parseJson<{ provider: string; results: unknown[] }>(result);
    expect(data.provider).toBe('photon');
    expect(data.results).toHaveLength(1);
  });

  it('returns an explanatory note when nothing matches', async () => {
    stubFetch(() => jsonResponse([]));
    const client = await connect();
    const result = await client.callTool({
      name: 'geocode',
      arguments: { query: 'zzzz-does-not-exist' },
    });
    const data = parseJson<{ results: unknown[]; note: string }>(result);
    expect(data.results).toEqual([]);
    expect(data.note).toContain('No match');
  });
});

describe('reverse_geocode', () => {
  it('returns the nearest address', async () => {
    stubFetch(() =>
      jsonResponse({
        lat: '49.7546',
        lon: '6.6424',
        display_name: 'Hauptmarkt, Trier, Germany',
        osm_type: 'node',
        osm_id: 42,
      })
    );
    const client = await connect();
    const result = await client.callTool({
      name: 'reverse_geocode',
      arguments: { latitude: 49.7546, longitude: 6.6424 },
    });
    const data = parseJson<{ result: { label: string } }>(result);
    expect(data.result.label).toBe('Hauptmarkt, Trier, Germany');
  });

  it('reports when nothing is found', async () => {
    stubFetch(() => jsonResponse({ error: 'Unable to geocode' }));
    const client = await connect();
    const result = await client.callTool({
      name: 'reverse_geocode',
      arguments: { latitude: 0, longitude: 0 },
    });
    const data = parseJson<{ result: null; note: string }>(result);
    expect(data.result).toBeNull();
  });
});

describe('poi_details', () => {
  it('returns the full tag set with a map link', async () => {
    stubFetch(() =>
      jsonResponse({
        elements: [
          {
            type: 'node',
            id: 240109189,
            lat: 49.7596,
            lon: 6.6439,
            tags: {
              name: 'Porta Nigra',
              historic: 'city_gate',
              opening_hours: 'Mo-Su 09:00-18:00',
              website: 'https://example.com',
            },
          },
        ],
      })
    );
    const client = await connect();
    const result = await client.callTool({
      name: 'poi_details',
      arguments: { osm_id: 'node/240109189' },
    });
    const data = parseJson<{
      name: string;
      map: string;
      tags: Record<string, string>;
    }>(result);
    expect(data.name).toBe('Porta Nigra');
    expect(data.map).toBe('https://www.openstreetmap.org/node/240109189');
    expect(data.tags.opening_hours).toBe('Mo-Su 09:00-18:00');
  });

  it('errors on an unknown element', async () => {
    stubFetch(() => jsonResponse({ elements: [] }));
    const client = await connect();
    const result = await client.callTool({
      name: 'poi_details',
      arguments: { osm_id: 'way/1' },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('no OSM element found');
  });
});

describe('suggest_meeting_point', () => {
  it('falls back to the midpoint when no venue is found', async () => {
    stubFetch(() => jsonResponse({ elements: [] }));
    const client = await connect();
    const result = await client.callTool({
      name: 'suggest_meeting_point',
      arguments: { locations: ['49.74,6.63', '49.76,6.65'] },
    });
    const data = parseJson<{ note: string; midpoint: { lat: number } }>(result);
    expect(data.note).toContain('No matching venue');
    expect(data.midpoint.lat).toBeCloseTo(49.75, 5);
  });
});

describe('response budgets', () => {
  it('truncates turn-by-turn steps beyond the cap', async () => {
    const steps = Array.from({ length: 150 }, (_, i) => ({
      distance: 10,
      name: `Street ${i}`,
      maneuver: { type: 'turn', modifier: 'left' },
    }));
    stubFetch(() =>
      jsonResponse({
        code: 'Ok',
        routes: [
          {
            distance: 1500,
            duration: 1200,
            legs: [{ distance: 1500, duration: 1200, steps }],
          },
        ],
      })
    );
    const client = await connect();
    const result = await client.callTool({
      name: 'route',
      arguments: {
        waypoints: ['49.75,6.64', '49.76,6.65'],
        profile: 'foot',
        include_steps: true,
      },
    });
    const data = parseJson<{ steps: unknown[]; steps_truncated: string }>(
      result
    );
    expect(data.steps).toHaveLength(100);
    expect(data.steps_truncated).toContain('first 100 of 150');
  });

  it('caps the tag count and value length in poi_details', async () => {
    const tags: Record<string, string> = { name: 'Big' };
    for (let i = 0; i < 80; i++) tags[`tag_${i}`] = 'v';
    tags.description = 'x'.repeat(2000);
    stubFetch(() =>
      jsonResponse({
        elements: [{ type: 'node', id: 1, lat: 49.75, lon: 6.64, tags }],
      })
    );
    const client = await connect();
    const result = await client.callTool({
      name: 'poi_details',
      arguments: { osm_id: 'node/1' },
    });
    const data = parseJson<{
      tags: Record<string, string>;
      tags_truncated: string;
    }>(result);
    expect(Object.keys(data.tags).length).toBeLessThanOrEqual(60);
    expect(data.tags_truncated).toContain('60 of 82');
    const description = data.tags.description ?? '';
    expect(description.length).toBeLessThanOrEqual(520);
  });
});
