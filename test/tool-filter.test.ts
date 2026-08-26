import { afterEach, describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { ToolFilterError } from '../src/tool-filter.js';
import { ALL_TOOLS, ESSENTIAL_TOOLS } from '../src/tools/catalogue.js';

// This server takes its configuration through loadConfig rather than a Config
// literal, so the filter is exercised the way an operator actually sets it: as
// environment variables.
function build(env: Record<string, string> = {}) {
  return createServer(loadConfig(env as NodeJS.ProcessEnv));
}

async function toolNames(env: Record<string, string> = {}): Promise<string[]> {
  const server = build(env);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  const { tools } = await client.listTools();
  return tools.map((t) => t.name).sort();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the catalogue', () => {
  // This is what lets the filter validate a name before anything is registered.
  // If it drifts from the code, every error message drifts too.
  it('is exactly the set of tools the server registers', async () => {
    expect(await toolNames()).toEqual([...ALL_TOOLS].sort());
  });

  it('holds names the env-var syntax cannot misread', () => {
    // A comma or an asterisk in a name would break the separator or the
    // pattern; a tool called "essential" would be unreachable behind the preset.
    for (const tool of ALL_TOOLS) {
      expect(tool).toMatch(/^[a-z0-9_]+$/);
    }
    expect(ALL_TOOLS).not.toContain('essential');
  });

  it('has an essential preset that is a real, sensibly sized subset', () => {
    expect(new Set(ESSENTIAL_TOOLS).size).toBe(ESSENTIAL_TOOLS.length);
    expect(ESSENTIAL_TOOLS.length).toBeGreaterThanOrEqual(5);
    expect(ESSENTIAL_TOOLS.length).toBeLessThanOrEqual(8);
    for (const tool of ESSENTIAL_TOOLS) expect(ALL_TOOLS).toContain(tool);
  });
});

describe('selecting tools', () => {
  it('narrows tools/list to an allow list', async () => {
    expect(await toolNames({ OSM_ALLOW_TOOLS: 'geocode,route' })).toEqual([
      'geocode',
      'route',
    ]);
  });

  it('removes a whole family with a prefix pattern', async () => {
    const names = await toolNames({ OSM_DENY_TOOLS: 'route_*' });
    expect(names).not.toContain('route_matrix');
    // The exact name survives — `route_*` is a prefix, not a fuzzy match.
    expect(names).toContain('route');
  });

  it('subtracts the deny list from the allow list', async () => {
    expect(
      await toolNames({
        OSM_ALLOW_TOOLS: 'geocode,reverse_geocode',
        OSM_DENY_TOOLS: 'reverse_geocode',
      })
    ).toEqual(['geocode']);
  });

  it('selects the curated set for "essential"', async () => {
    expect(await toolNames({ OSM_ALLOW_TOOLS: 'essential' })).toEqual(
      [...ESSENTIAL_TOOLS].sort()
    );
  });

  it('lets the preset compose with extra names', async () => {
    expect(await toolNames({ OSM_ALLOW_TOOLS: 'essential,isochrone' })).toEqual(
      [...ESSENTIAL_TOOLS, 'isochrone'].sort()
    );
  });

  it('trims entries, ignores case and skips empty ones', async () => {
    expect(await toolNames({ OSM_ALLOW_TOOLS: ' GEOCODE ,, route, ' })).toEqual(
      ['geocode', 'route']
    );
  });

  it('treats an empty value as no filter at all', async () => {
    // `OSM_ALLOW_TOOLS=` in a compose file must not mean "allow nothing".
    expect(await toolNames({ OSM_ALLOW_TOOLS: '   ' })).toEqual(
      [...ALL_TOOLS].sort()
    );
  });

  it('leaves an unconfigured server untouched', async () => {
    expect(await toolNames()).toEqual([...ALL_TOOLS].sort());
  });
});

describe('a filtered-out tool', () => {
  it('cannot be called either, not merely hidden', async () => {
    // This is the difference between removing the tool and disabling it: a
    // disabled tool still answers a call, which advertises a refusal.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const server = build({ OSM_ALLOW_TOOLS: 'geocode' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    const result = (await client.callTool({
      name: 'isochrone',
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      'Tool isochrone not found'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('refusing an unusable list', () => {
  it('rejects a name no tool has, and says which names exist', () => {
    // A typo that was merely ignored would leave a tool missing with no trace
    // of why — nobody looks for the cause of an absence in an env var.
    expect(() => build({ OSM_ALLOW_TOOLS: 'geocodez' })).toThrow(
      ToolFilterError
    );
    expect(() => build({ OSM_ALLOW_TOOLS: 'geocodez' })).toThrow(
      /no tool matches "geocodez".*geocode/s
    );
  });

  it('rejects a pattern that matches nothing', () => {
    expect(() => build({ OSM_ALLOW_TOOLS: 'zzz_*' })).toThrow(
      /no tool matches "zzz_\*"/
    );
  });

  it('rejects a pattern with the star anywhere but last', () => {
    expect(() => build({ OSM_ALLOW_TOOLS: '*_geocode' })).toThrow(
      /single trailing "\*"/
    );
    expect(() => build({ OSM_ALLOW_TOOLS: 'route_*_x' })).toThrow(
      /single trailing "\*"/
    );
  });

  it('applies the same rule to the deny list', () => {
    expect(() => build({ OSM_DENY_TOOLS: 'geocodez' })).toThrow(
      /OSM_DENY_TOOLS: no tool matches "geocodez"/
    );
  });

  it('rejects a list that would leave no tools at all', () => {
    expect(() => build({ OSM_DENY_TOOLS: '*' })).toThrow(/empty tool list/);
  });
});
