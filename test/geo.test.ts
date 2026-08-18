import { describe, expect, it } from 'vitest';

import {
  formatDistance,
  formatDuration,
  haversineMeters,
  parseCoordinates,
  roundCoord,
} from '../src/geo.js';

describe('haversineMeters', () => {
  it('measures Trier to Luxembourg at roughly 40 km', () => {
    const meters = haversineMeters(
      { lat: 49.7596, lon: 6.6439 },
      { lat: 49.6116, lon: 6.1319 }
    );
    expect(meters).toBeGreaterThan(38_000);
    expect(meters).toBeLessThan(43_000);
  });

  it('returns 0 for identical points', () => {
    expect(haversineMeters({ lat: 50, lon: 6 }, { lat: 50, lon: 6 })).toBe(0);
  });
});

describe('parseCoordinates', () => {
  it('parses "lat,lon" with and without spaces', () => {
    expect(parseCoordinates('49.7596, 6.6439')).toEqual({
      lat: 49.7596,
      lon: 6.6439,
    });
    expect(parseCoordinates('-33.9,151.2')).toEqual({ lat: -33.9, lon: 151.2 });
  });

  it('rejects place names and out-of-range values', () => {
    expect(parseCoordinates('Trier')).toBeNull();
    expect(parseCoordinates('Trier, Germany')).toBeNull();
    expect(parseCoordinates('91,0')).toBeNull();
    expect(parseCoordinates('0,181')).toBeNull();
  });
});

describe('formatting', () => {
  it('formats distances', () => {
    expect(formatDistance(850)).toBe('850 m');
    expect(formatDistance(1234)).toBe('1.2 km');
    expect(formatDistance(41_500)).toBe('42 km');
  });

  it('formats durations', () => {
    expect(formatDuration(20)).toBe('< 1 min');
    expect(formatDuration(90)).toBe('2 min');
    expect(formatDuration(5400)).toBe('1 h 30 min');
    expect(formatDuration(7200)).toBe('2 h');
  });

  it('rounds coordinates to ~1 m precision', () => {
    expect(roundCoord(49.75961234)).toBe(49.75961);
  });
});
