import { afterEach, describe, expect, it, vi } from 'vitest';

import { NominatimBackend } from '../src/backends/nominatim.js';
import { OrsBackend } from '../src/backends/ors.js';
import { OsrmBackend } from '../src/backends/osrm.js';
import { OverpassBackend, parseTagSelector } from '../src/backends/overpass.js';
import { PhotonBackend } from '../src/backends/photon.js';
import { ValhallaBackend } from '../src/backends/valhalla.js';
import { loadConfig } from '../src/config.js';
import {
  HttpClient,
  OsmApiError,
  RateLimiter,
  type RequestOptions,
} from '../src/http.js';

const config = loadConfig({} as NodeJS.ProcessEnv);
const noWait = () => new RateLimiter(0);

function http(): HttpClient {
  return new HttpClient('test/1.0', 0);
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NominatimBackend', () => {
  it('builds a policy-compliant search request and maps results', async () => {
    const mock = stubFetch(() =>
      jsonResponse([
        {
          lat: '49.7596208',
          lon: '6.6439115',
          display_name: 'Trier, Rheinland-Pfalz, Germany',
          osm_type: 'relation',
          osm_id: 172679,
          category: 'boundary',
          type: 'administrative',
        },
      ])
    );
    const backend = new NominatimBackend(http(), config, noWait());
    const results = await backend.search('Trier', {
      language: 'de',
      countrycodes: 'DE',
    });
    const url = new URL(String(mock.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe(
      'https://nominatim.openstreetmap.org/search'
    );
    expect(url.searchParams.get('format')).toBe('jsonv2');
    expect(url.searchParams.get('accept-language')).toBe('de');
    expect(url.searchParams.get('countrycodes')).toBe('de');
    expect(results).toEqual([
      {
        lat: 49.75962,
        lon: 6.64391,
        label: 'Trier, Rheinland-Pfalz, Germany',
        osm: 'relation/172679',
        kind: 'boundary/administrative',
      },
    ]);
  });

  it('returns null when reverse finds nothing', async () => {
    stubFetch(() => jsonResponse({ error: 'Unable to geocode' }));
    const backend = new NominatimBackend(http(), config, noWait());
    expect(await backend.reverse(0, 0)).toBeNull();
  });
});

describe('PhotonBackend', () => {
  it('maps GeoJSON features and falls back to the default language', async () => {
    const mock = stubFetch(() =>
      jsonResponse({
        features: [
          {
            geometry: { coordinates: [6.6439, 49.7596] },
            properties: {
              name: 'Porta Nigra',
              city: 'Trier',
              country: 'Germany',
              osm_type: 'W',
              osm_id: 24526783,
              osm_key: 'historic',
              osm_value: 'city_gate',
            },
          },
        ],
      })
    );
    const backend = new PhotonBackend(http(), config, noWait());
    const results = await backend.search('porta nigra', { language: 'es' });
    const url = new URL(String(mock.mock.calls[0]![0]));
    expect(url.searchParams.get('lang')).toBe('default');
    expect(results[0]).toMatchObject({
      lat: 49.7596,
      lon: 6.6439,
      label: 'Porta Nigra, Trier, Germany',
      osm: 'way/24526783',
      kind: 'historic/city_gate',
    });
  });
});

describe('OsrmBackend', () => {
  const trier = { lat: 49.7596, lon: 6.6439 };
  const lux = { lat: 49.6116, lon: 6.1319 };

  it('selects the profile via the routed-* path prefix, not the inner segment', async () => {
    const mock = stubFetch(() =>
      jsonResponse({
        code: 'Ok',
        routes: [{ distance: 44000, duration: 31000, legs: [] }],
      })
    );
    const backend = new OsrmBackend(http(), config, noWait());
    await backend.route('foot', [trier, lux]);
    const url = String(mock.mock.calls[0]![0]);
    // The FOSSGIS demo servers ignore the profile inside the OSRM path — the
    // routed-foot prefix is the only thing that actually selects walking.
    expect(url).toContain(
      'routing.openstreetmap.de/routed-foot/route/v1/driving/'
    );
    expect(url).toContain('6.6439,49.7596;6.1319,49.6116');
  });

  it('throws on a non-Ok response code', async () => {
    stubFetch(() => jsonResponse({ code: 'NoRoute', message: 'nope' }));
    const backend = new OsrmBackend(http(), config, noWait());
    await expect(backend.route('car', [trier, lux])).rejects.toThrow(
      /code: .*NoRoute.*message: .*nope/
    );
  });

  it('requests a table with sources/destinations split', async () => {
    const mock = stubFetch(() =>
      jsonResponse({
        code: 'Ok',
        durations: [[100, 200]],
        distances: [[1000, 2000]],
      })
    );
    const backend = new OsrmBackend(http(), config, noWait());
    const matrix = await backend.table('car', [trier], [lux, trier]);
    const url = new URL(String(mock.mock.calls[0]![0]));
    expect(url.pathname).toContain('/routed-car/table/v1/driving/');
    expect(url.searchParams.get('sources')).toBe('0');
    expect(url.searchParams.get('destinations')).toBe('1;2');
    expect(url.searchParams.get('annotations')).toBe('duration,distance');
    expect(matrix.durations).toEqual([[100, 200]]);
  });

  it('inverts the trip waypoint order correctly', async () => {
    stubFetch(() =>
      jsonResponse({
        code: 'Ok',
        trips: [{ distance: 5000, duration: 3600, legs: [] }],
        // input 0 is visited 2nd, input 1 first, input 2 third
        waypoints: [
          { waypoint_index: 1 },
          { waypoint_index: 0 },
          { waypoint_index: 2 },
        ],
      })
    );
    const backend = new OsrmBackend(http(), config, noWait());
    const trip = await backend.trip('bike', [trier, lux, trier], true);
    expect(trip.order).toEqual([1, 0, 2]);
  });
});

const Z = 'https://z.overpass-api.de/api/interpreter';
const LZ4 = 'https://lz4.overpass-api.de/api/interpreter';
const ONE_ELEMENT = {
  elements: [
    { type: 'node', id: 1, lat: 49.75, lon: 6.64, tags: { name: 'X' } },
  ],
};
const TIMED_OUT =
  'runtime error: Query timed out in "query" at line 1 after 21 seconds.';

function many(n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `https://m${i + 1}.example/api/interpreter`
  );
}

function overpassConfig(...urls: string[]) {
  return loadConfig({
    OVERPASS_BASE_URL: urls.join(','),
  } as unknown as NodeJS.ProcessEnv);
}

function timeoutError(): DOMException {
  return new DOMException(
    'The operation was aborted due to timeout',
    'TimeoutError'
  );
}

function networkError(code?: string, message = 'fetch failed'): TypeError {
  const cause = new Error(
    code ? `getaddrinfo ${code} host` : 'unexpected redirect'
  );
  return new TypeError(message, {
    cause: code ? Object.assign(cause, { code }) : cause,
  });
}

function overpass(cfg = config, client = http()): OverpassBackend {
  return new OverpassBackend(client, cfg, noWait(), () => Promise.resolve());
}

/** Fails the first endpoint with `first`, answers ONE_ELEMENT on every other. */
function firstFails(first: () => Response) {
  const urls: string[] = [];
  stubFetch((url) => {
    urls.push(url);
    return urls.length === 1 ? first() : jsonResponse(ONE_ELEMENT);
  });
  return urls;
}

describe('OverpassBackend', () => {
  it('defaults to the two machines behind overpass-api.de, z first', async () => {
    const urls = firstFails(() => new Response('too many', { status: 429 }));
    const pois = await overpass().findNearby(
      { lat: 49.75, lon: 6.64 },
      { key: 'amenity', value: 'cafe' },
      500,
      10
    );
    expect(urls).toEqual([Z, LZ4]);
    expect(pois[0]).toMatchObject({ name: 'X', osm: 'node/1' });
  });

  it('asks the server for a 20-second query timeout', async () => {
    const mock = stubFetch(() => jsonResponse(ONE_ELEMENT));
    await overpass().byId('node', 1);
    const body = decodeURIComponent(String(mock.mock.calls[0]![1]?.body));
    expect(body).toContain('[out:json][timeout:20];node(1)');
  });

  it.each([401, 403, 404, 408, 410, 429, 500, 502, 503, 504])(
    'fails over on HTTP %i',
    async (status) => {
      const urls = firstFails(() => new Response('no', { status }));
      expect(await overpass().query('[out:json];node(1);out;')).toHaveLength(1);
      expect(urls).toEqual([Z, LZ4]);
    }
  );

  it('does not fail over on a bad query, and keeps its body', async () => {
    const urls: string[] = [];
    stubFetch((url) => {
      urls.push(url);
      return new Response('parse error', { status: 400 });
    });
    await expect(overpass().query('malformed')).rejects.toMatchObject({
      status: 400,
      body: 'parse error',
    });
    expect(urls).toHaveLength(1);
  });

  it('surfaces the 400 when it follows a 504', async () => {
    let call = 0;
    stubFetch(
      () => new Response('x', { status: (call += 1) === 1 ? 504 : 400 })
    );
    await expect(overpass().query('malformed')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('fails over when an endpoint times out', async () => {
    const urls: string[] = [];
    stubFetch((url) => {
      urls.push(url);
      if (url === Z) throw timeoutError();
      return jsonResponse(ONE_ELEMENT);
    });
    expect(await overpass().query('[out:json];node(1);out;')).toHaveLength(1);
    expect(urls).toEqual([Z, LZ4]);
  });

  it('fails over when an endpoint cannot be reached, and names the cause', async () => {
    const urls: string[] = [];
    stubFetch((url) => {
      urls.push(url);
      throw networkError('ENOTFOUND');
    });
    await expect(overpass().query('[out:json];node(1);out;')).rejects.toThrow(
      'all Overpass endpoints failed (#1 https://z.overpass-api.de: unreachable (ENOTFOUND); ' +
        '#2 https://lz4.overpass-api.de: unreachable (ENOTFOUND)). ' +
        'No endpoint accepted the request — check OVERPASS_BASE_URL'
    );
    expect(urls).toEqual([Z, LZ4]);
  });

  it('fails over on a refused redirect, which has no error code', async () => {
    let call = 0;
    stubFetch(() => {
      if ((call += 1) === 1) throw networkError();
      throw networkError('ECONNREFUSED');
    });
    await expect(overpass().query('[out:json];node(1);out;')).rejects.toThrow(
      '#1 https://z.overpass-api.de: unreachable (network error); ' +
        '#2 https://lz4.overpass-api.de: unreachable (ECONNREFUSED)'
    );
  });

  it('fails over when the connection drops half-way through the body', async () => {
    const urls = firstFails(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"elem'));
              controller.error(networkError('UND_ERR_SOCKET', 'terminated'));
            },
          }),
          { status: 200 }
        )
    );
    expect(await overpass().query('[out:json];node(1);out;')).toHaveLength(1);
    expect(urls).toEqual([Z, LZ4]);
  });

  it('does not fail over on a TypeError without a cause (a bug, not the network)', async () => {
    const urls: string[] = [];
    stubFetch((url) => {
      urls.push(url);
      throw new TypeError('x is not a function');
    });
    await expect(overpass().query('[out:json];node(1);out;')).rejects.toThrow(
      'x is not a function'
    );
    expect(urls).toHaveLength(1);
  });

  it.each([
    ['without elements', []],
    ['with partial elements', ONE_ELEMENT.elements],
  ])(
    'fails over on a runtime error answered with 200, %s',
    async (_, elements) => {
      const urls: string[] = [];
      stubFetch((url) => {
        urls.push(url);
        return url === Z
          ? jsonResponse({ elements, remark: TIMED_OUT })
          : jsonResponse({
              elements: [ONE_ELEMENT.elements[0], ONE_ELEMENT.elements[0]],
            });
      });
      expect(await overpass().query('[out:json];node(1);out;')).toHaveLength(2);
      expect(urls).toEqual([Z, LZ4]);
    }
  );

  it('reports the runtime error, cleaned and labelled, when every endpoint has one', async () => {
    stubFetch(() =>
      jsonResponse({
        elements: [],
        remark: `${TIMED_OUT}\u001b[2J${'x'.repeat(500)}`,
      })
    );
    const error = await overpass()
      .query('[out:json];node(1);out;')
      .then(
        () => null,
        (e: unknown) => e as Error
      );
    expect(error?.message).toContain(
      `#1 https://z.overpass-api.de: Overpass reported (untrusted text from the service) ${TIMED_OUT}`
    );
    expect(error?.message).toContain('… (truncated)');
    expect(error?.message).not.toContain('\u001b');
    expect(error?.message).toContain('The public servers may be overloaded');
  });

  it.each([
    ['a runtime remark', 'runtime remark: Timeout is 20 seconds.'],
    ['a remark that is not text', 5],
    ['an empty remark', ''],
  ])('treats %s as success', async (_, remark) => {
    const mock = stubFetch(() => jsonResponse({ ...ONE_ELEMENT, remark }));
    expect(await overpass().query('[out:json];node(1);out;')).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('never caches an answer that carries a runtime error', async () => {
    let answer: unknown = { elements: [], remark: TIMED_OUT };
    const mock = stubFetch(() => jsonResponse(answer));
    const backend = overpass(config, new HttpClient('test/1.0', 60_000));
    await expect(backend.query('[out:json];node(1);out;')).rejects.toThrow(
      'runtime error'
    );
    expect(mock).toHaveBeenCalledTimes(2);
    answer = ONE_ELEMENT;
    expect(await backend.query('[out:json];node(1);out;')).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(3);
    // A good answer is cached as before.
    expect(await backend.query('[out:json];node(1);out;')).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('numbers the endpoints and never prints a path or a key', async () => {
    const keyA = 'aaaa1111bbbb2222cccc';
    const keyB = 'dddd3333eeee4444ffff';
    stubFetch(() => new Response('denied', { status: 403 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = await overpass(
      overpassConfig(
        `https://paid.example/${keyA}/api/interpreter`,
        `https://paid.example:8443/${keyB}/api/interpreter`
      )
    )
      .query('[out:json];node(1);out;')
      .then(
        () => null,
        (e: unknown) => e as Error
      );
    expect(error?.message).toBe(
      'all Overpass endpoints failed (#1 https://paid.example: HTTP 403; ' +
        '#2 https://paid.example:8443: HTTP 403). No endpoint accepted the request — ' +
        'check OVERPASS_BASE_URL (addresses, keys) and the network.'
    );
    expect(error?.message).not.toMatch(/interpreter|aaaa1111|dddd3333/);
  });

  it('gives the overload hint as soon as one endpoint was busy', async () => {
    let call = 0;
    stubFetch(
      () => new Response('x', { status: (call += 1) === 1 ? 403 : 504 })
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(overpass().query('[out:json];node(1);out;')).rejects.toThrow(
      /HTTP 403; #2 https:\/\/lz4\.overpass-api\.de: HTTP 504\)\. The public servers may be overloaded/
    );
  });

  describe('warns about a refused request', () => {
    it('once per endpoint, naming only its origin', async () => {
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
      stubFetch((url) =>
        url.includes('paid')
          ? new Response('no', { status: 401 })
          : jsonResponse(ONE_ELEMENT)
      );
      const backend = overpass(
        overpassConfig(
          'https://paid.example/aaaa1111bbbb2222cccc/api/interpreter',
          LZ4
        )
      );
      await backend.query('[out:json];node(1);out;');
      await backend.query('[out:json];node(2);out;');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toBe(
        'osm-mcp: WARNING: Overpass endpoint #1 (https://paid.example) refused the request with HTTP 401 — check its key'
      );
    });

    it('once for each of two refusing endpoints', async () => {
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
      stubFetch(() => new Response('no', { status: 403 }));
      await expect(
        overpass().query('[out:json];node(1);out;')
      ).rejects.toThrow();
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('never for an overloaded endpoint', async () => {
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
      firstFails(() => new Response('busy', { status: 503 }));
      await overpass().query('[out:json];node(1);out;');
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('time budget', () => {
    type Outcome = 'hang' | 'busy' | 'ok';

    /** A fake clock that the stubbed requests and back-offs advance. */
    function rig(urls: string[], outcomes: Outcome[]) {
      const state = { clock: 0 };
      const timeouts: number[] = [];
      const sleeps: number[] = [];
      const request = vi.fn(
        async (
          _service: string,
          _url: string,
          _limiter: unknown,
          options: RequestOptions
        ) => {
          const outcome = outcomes[timeouts.length] ?? 'ok';
          timeouts.push(options.timeoutMs!);
          if (outcome === 'hang') {
            state.clock += options.timeoutMs!;
            throw timeoutError();
          }
          if (outcome === 'busy') {
            throw new OsmApiError(504, '', 'overpass', 'https://busy.example');
          }
          return ONE_ELEMENT;
        }
      );
      const backend = new OverpassBackend(
        { request } as unknown as HttpClient,
        overpassConfig(...urls),
        noWait(),
        async (ms) => {
          sleeps.push(ms);
          state.clock += ms;
        },
        () => state.clock
      );
      return { backend, timeouts, sleeps, state, request };
    }

    it('gives a lone endpoint 40 s, not the whole 50 s budget', async () => {
      const { backend, timeouts } = rig([Z], ['ok']);
      await backend.query('q');
      expect(timeouts).toEqual([40_000]);
    });

    it('splits the budget between the two default endpoints', async () => {
      const { backend, timeouts, sleeps, state } = rig(
        [Z, LZ4],
        ['hang', 'hang']
      );
      await expect(backend.query('q')).rejects.toThrow(
        '#1 https://z.overpass-api.de: no answer within 25 s; ' +
          '#2 https://lz4.overpass-api.de: no answer within 24 s)'
      );
      expect(timeouts).toEqual([25_000, 24_000]);
      expect(sleeps).toEqual([1000]);
      expect(state.clock).toBe(50_000);
    });

    it('hands the full 40 s on when the first endpoint fails fast', async () => {
      const { backend, timeouts } = rig([Z, LZ4], ['busy', 'ok']);
      expect(await backend.query('q')).toHaveLength(1);
      expect(timeouts).toEqual([25_000, 40_000]);
    });

    it('stops when the rest of the budget is below 20 s, and says how many were left out', async () => {
      const { backend, timeouts } = rig(many(8), Array(8).fill('hang'));
      await expect(backend.query('q')).rejects.toThrow(
        '#3 to #8 not tried: time budget used up)'
      );
      expect(timeouts).toEqual([20_000, 20_000]);
    });

    it('starts an attempt with exactly 20 s left, and not with one millisecond less', async () => {
      // The first endpoint answers 504 after `elapsed` ms; with the 1 s
      // back-off, 29 s leave the second one exactly 20 s.
      for (const [elapsed, tried] of [
        [29_000, 2],
        [29_001, 1],
      ] as const) {
        const { backend, timeouts, state, request } = rig([Z, LZ4], []);
        request.mockImplementation(
          async (
            _s: string,
            _u: string,
            _l: unknown,
            options: RequestOptions
          ) => {
            timeouts.push(options.timeoutMs!);
            state.clock += timeouts.length === 1 ? elapsed : 0;
            throw new OsmApiError(504, '', 'overpass', 'https://busy.example');
          }
        );
        await expect(backend.query('q')).rejects.toThrow(
          tried === 2 ? 'HTTP 504; #2' : '#2 not tried: time budget used up'
        );
        expect(timeouts).toEqual(tried === 2 ? [25_000, 20_000] : [25_000]);
      }
    });

    it('does not sleep a back-off it has no time left to use', async () => {
      const { backend, sleeps } = rig(many(3), ['hang', 'hang', 'hang']);
      await backend.query('q').catch(() => {});
      expect(sleeps).toEqual([1000]);
    });

    it('counts the wait for a free slot against the budget', async () => {
      const { backend, timeouts, state, request } = rig([Z, LZ4], []);
      const gates: Array<() => void> = [];
      request.mockImplementation(
        async (
          _s: string,
          _u: string,
          _l: unknown,
          options: RequestOptions
        ) => {
          timeouts.push(options.timeoutMs!);
          if (gates.length < 2) {
            await new Promise<void>((resolve) => gates.push(resolve));
            return ONE_ELEMENT;
          }
          state.clock += options.timeoutMs!;
          throw timeoutError();
        }
      );
      const first = backend.query('a');
      const second = backend.query('b');
      const third = backend.query('c'); // waits for one of the two slots
      await vi.waitFor(() => expect(gates).toHaveLength(2));
      state.clock = 45_000;
      gates.forEach((open) => open());
      await Promise.all([first, second]);
      await expect(third).rejects.toThrow(
        '#1 https://z.overpass-api.de: no answer within 20 s; #2 not tried: time budget used up'
      );
      // Only 5 s of the budget were left: the one attempt gets the floor, no more.
      expect(timeouts).toEqual([25_000, 25_000, 20_000]);
    });
  });

  it('uses way/relation centers as coordinates', async () => {
    stubFetch(() =>
      jsonResponse({
        elements: [
          {
            type: 'way',
            id: 2,
            center: { lat: 49.7, lon: 6.6 },
            tags: { name: 'Museum' },
          },
        ],
      })
    );
    const pois = await overpass().findNearby(
      { lat: 49.7, lon: 6.6 },
      { key: 'tourism' },
      500,
      10
    );
    expect(pois[0]).toMatchObject({ lat: 49.7, lon: 6.6, osm: 'way/2' });
  });
});

describe('parseTagSelector', () => {
  it('accepts key and key=value', () => {
    expect(parseTagSelector('tourism')).toEqual({ key: 'tourism' });
    expect(parseTagSelector('diet:vegan=yes')).toEqual({
      key: 'diet:vegan',
      value: 'yes',
    });
  });

  it('rejects anything that could escape the Overpass QL string', () => {
    expect(() => parseTagSelector('amenity="]')).toThrow(/invalid tag filter/);
    expect(() => parseTagSelector('a=b=c')).toThrow(/invalid tag filter/);
    expect(() => parseTagSelector('name~"x"')).toThrow(/invalid tag filter/);
  });
});

describe('ValhallaBackend', () => {
  it('maps profiles to Valhalla costings and flattens contours', async () => {
    const mock = stubFetch(() =>
      jsonResponse({
        features: [
          {
            properties: { contour: 15 },
            geometry: {
              type: 'LineString',
              coordinates: [
                [6.6, 49.7],
                [6.7, 49.8],
              ],
            },
          },
        ],
      })
    );
    const backend = new ValhallaBackend(http(), config, noWait());
    const contours = await backend.isochrone(
      { lat: 49.75, lon: 6.65 },
      'foot',
      { minutes: 15 }
    );
    const url = new URL(String(mock.mock.calls[0]![0]));
    const request = JSON.parse(url.searchParams.get('json')!) as {
      costing: string;
      contours: unknown[];
    };
    expect(url.pathname).toBe('/isochrone');
    expect(request.costing).toBe('pedestrian');
    expect(request.contours).toEqual([{ time: 15 }]);
    expect(contours[0]).toEqual({
      value: 15,
      coordinates: [
        { lon: 6.6, lat: 49.7 },
        { lon: 6.7, lat: 49.8 },
      ],
    });
  });
});

describe('OrsBackend', () => {
  const withKey = loadConfig({
    ORS_API_KEY: 'test-key-0123456789',
  } as NodeJS.ProcessEnv);

  it('is disabled without a key', () => {
    expect(new OrsBackend(http(), config).enabled).toBe(false);
    expect(new OrsBackend(http(), withKey).enabled).toBe(true);
  });

  it('routes via the mapped profile with the key in the header', async () => {
    const mock = stubFetch(() =>
      jsonResponse({
        routes: [
          {
            summary: { distance: 44000, duration: 31000 },
            segments: [{ distance: 44000, duration: 31000 }],
          },
        ],
      })
    );
    const backend = new OrsBackend(http(), withKey, noWait());
    const route = await backend.route('foot', [
      { lat: 49.7596, lon: 6.6439 },
      { lat: 49.6116, lon: 6.1319 },
    ]);
    const url = String(mock.mock.calls[0]![0]);
    const init = mock.mock.calls[0]![1]!;
    expect(url).toBe(
      'https://api.openrouteservice.org/v2/directions/foot-walking'
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'test-key-0123456789'
    );
    expect(JSON.parse(String(init.body))).toEqual({
      coordinates: [
        [6.6439, 49.7596],
        [6.1319, 49.6116],
      ],
      instructions: false,
    });
    expect(route.distanceMeters).toBe(44000);
  });

  it('normalizes isochrone values back to minutes', async () => {
    stubFetch(() =>
      jsonResponse({
        features: [
          {
            properties: { value: 900 },
            geometry: { coordinates: [[[6.6, 49.7]]] },
          },
        ],
      })
    );
    const backend = new OrsBackend(http(), withKey, noWait());
    const contours = await backend.isochrone({ lat: 49.75, lon: 6.65 }, 'car', {
      minutes: 15,
    });
    expect(contours[0]!.value).toBe(15);
    expect(contours[0]!.coordinates).toEqual([{ lon: 6.6, lat: 49.7 }]);
  });
});

describe('audit regressions', () => {
  it('resolveCategory does not resolve prototype keys to functions', async () => {
    const { resolveCategory } = await import('../src/categories.js');
    for (const key of ['constructor', '__proto__', 'toString', 'valueOf']) {
      const selector = resolveCategory(key);
      expect(typeof selector.key).toBe('string');
    }
    expect(() => resolveCategory('hasOwnProperty()')).toThrow(
      /invalid tag filter/
    );
  });

  it('photon ignores prototype-key osm_type values from upstream', async () => {
    stubFetch(() =>
      jsonResponse({
        features: [
          {
            geometry: { coordinates: [6.64, 49.75] },
            properties: { name: 'X', osm_type: 'constructor', osm_id: 5 },
          },
        ],
      })
    );
    const backend = new PhotonBackend(http(), config, noWait());
    const results = await backend.search('x');
    expect(results[0]!.osm).toBeUndefined();
  });

  it('drops geocode results with non-finite coordinates', async () => {
    stubFetch(() =>
      jsonResponse([
        { lat: 'not-a-number', lon: '6.64', display_name: 'Broken' },
        { lat: '49.75', lon: '6.64', display_name: 'Fine' },
      ])
    );
    const backend = new NominatimBackend(http(), config, noWait());
    const results = await backend.search('x');
    expect(results).toHaveLength(1);
    expect(results[0]!.label).toBe('Fine');
  });
});
