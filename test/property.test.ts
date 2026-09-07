import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  boundingBoxOf,
  formatDistance,
  formatDuration,
  haversineMeters,
  isValidLatLon,
  parseCoordinates,
  roundCoord,
  type LatLon,
} from '../src/geo.js';

/**
 * Properties of the geometry helpers.
 *
 * Everything here is arithmetic, which is the one kind of code where an example
 * test is least useful and a property most: a distance function is either right
 * for every pair of points or wrong in a way three chosen pairs will not show.
 * `parseCoordinates` additionally reads a string a caller typed, and its
 * refusals are what keep a malformed pair from becoming a plausible-looking
 * location somewhere else in the world.
 */

const RUNS = { numRuns: 500 };

const latitude = fc.double({ min: -90, max: 90, noNaN: true });
const longitude = fc.double({ min: -180, max: 180, noNaN: true });
const point: fc.Arbitrary<LatLon> = fc.record({
  lat: latitude,
  lon: longitude,
});

describe('distance behaves like a distance', () => {
  it('is zero from a point to itself', () => {
    fc.assert(
      fc.property(point, (a) => {
        expect(haversineMeters(a, a)).toBeCloseTo(0, 6);
      }),
      RUNS
    );
  });

  it('is symmetric', () => {
    fc.assert(
      fc.property(point, point, (a, b) => {
        expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
      }),
      RUNS
    );
  });

  /**
   * The triangle inequality is the property that catches a sign error or a
   * swapped latitude and longitude — both of which still produce a plausible
   * number for any single pair.
   */
  it('never takes a detour that is shorter than going direct', () => {
    fc.assert(
      fc.property(point, point, point, (a, b, c) => {
        const direct = haversineMeters(a, c);
        const detour = haversineMeters(a, b) + haversineMeters(b, c);
        // Relative tolerance: at antipodal distances the two sides differ by
        // fractions of a metre out of twenty thousand kilometres, which is
        // float arithmetic rather than a detour that is genuinely shorter.
        expect(detour).toBeGreaterThanOrEqual(direct - direct * 1e-9 - 1e-6);
      }),
      RUNS
    );
  });

  /** Half the circumference is the furthest two points on a sphere can be. */
  it('never exceeds half the circumference', () => {
    fc.assert(
      fc.property(point, point, (a, b) => {
        expect(haversineMeters(a, b)).toBeLessThanOrEqual(20_015_200);
      }),
      RUNS
    );
  });
});

describe('coordinates parse back to what was written', () => {
  it('a formatted pair round trips', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -9000, max: 9000 }),
        fc.integer({ min: -18000, max: 18000 }),
        fc.constantFrom(', ', ',', ' , ', '  ,  '),
        (latHundredths, lonHundredths, separator) => {
          const lat = latHundredths / 100;
          const lon = lonHundredths / 100;
          const parsed = parseCoordinates(`${lat}${separator}${lon}`);
          expect(parsed).toEqual({ lat, lon });
        }
      ),
      RUNS
    );
  });

  /**
   * A pair outside the valid range is refused rather than clamped.
   *
   * Clamping would turn a typo into a location — a longitude of 200 becoming
   * 180 puts the answer in the Pacific and says nothing about it.
   */
  it('refuses a pair outside the valid range', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 91, max: 999 }),
          fc.integer({ min: -999, max: -91 })
        ),
        (lat) => {
          expect(parseCoordinates(`${lat}, 0`)).toBeNull();
          expect(isValidLatLon(lat, 0)).toBe(false);
        }
      ),
      RUNS
    );
  });

  it('refuses anything that is not a plain pair', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (input) => {
        const parsed = parseCoordinates(input);
        if (parsed === null) return;
        expect(isValidLatLon(parsed.lat, parsed.lon)).toBe(true);
      }),
      RUNS
    );
  });

  it('rounds to five decimals and no further', () => {
    fc.assert(
      fc.property(fc.double({ min: -180, max: 180, noNaN: true }), (value) => {
        const rounded = roundCoord(value);
        expect(Math.abs(rounded - value)).toBeLessThanOrEqual(5e-6 + 1e-9);
        expect(Math.round(rounded * 1e5)).toBeCloseTo(rounded * 1e5, 6);
      }),
      RUNS
    );
  });
});

describe('a bounding box covers everything it was given', () => {
  /**
   * The one thing a bounding box must never do is leave a point out — the
   * comment on `MAX_CONTOUR_POINTS` says exactly why silently keeping the first
   * 50 000 points of a ring would be worse than refusing: the box computed from
   * them would cover part of the contour and say nothing about it.
   */
  it('contains every point', () => {
    fc.assert(
      fc.property(
        fc.array(point, { minLength: 1, maxLength: 40 }),
        (points) => {
          const box = boundingBoxOf(points);
          for (const p of points) {
            expect(p.lat).toBeGreaterThanOrEqual(box.south);
            expect(p.lat).toBeLessThanOrEqual(box.north);
            expect(p.lon).toBeGreaterThanOrEqual(box.west);
            expect(p.lon).toBeLessThanOrEqual(box.east);
          }
        }
      ),
      RUNS
    );
  });

  it('is never inverted', () => {
    fc.assert(
      fc.property(
        fc.array(point, { minLength: 1, maxLength: 40 }),
        (points) => {
          const box = boundingBoxOf(points);
          expect(box.north).toBeGreaterThanOrEqual(box.south);
          expect(box.east).toBeGreaterThanOrEqual(box.west);
        }
      ),
      RUNS
    );
  });

  it('does not depend on the order the points arrived in', () => {
    fc.assert(
      fc.property(
        fc.array(point, { minLength: 1, maxLength: 20 }),
        (points) => {
          expect(boundingBoxOf(points)).toEqual(
            boundingBoxOf(points.toReversed())
          );
        }
      ),
      RUNS
    );
  });
});

describe('formatting never invents a number', () => {
  it('a distance is always a number with a unit, or unknown', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ min: 0, max: 1e8, noNaN: true }),
          fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY)
        ),
        (meters) => {
          expect(formatDistance(meters)).toMatch(/^(unknown|[\d.]+ (m|km))$/);
        }
      ),
      RUNS
    );
  });

  it('a duration is always readable, or unknown', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ min: 0, max: 1e7, noNaN: true }),
          fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY)
        ),
        (seconds) => {
          expect(formatDuration(seconds)).toMatch(
            /^(unknown|< 1 min|\d+ min|\d+ h( \d+ min)?)$/
          );
        }
      ),
      RUNS
    );
  });

  /**
   * A duration below a minute says so rather than rounding to `0 min`, which
   * would read as "no time at all" for a leg that is genuinely a short walk.
   */
  it('never reports zero minutes', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 59, noNaN: true }), (seconds) => {
        expect(formatDuration(seconds)).not.toBe('0 min');
      }),
      RUNS
    );
  });
});
