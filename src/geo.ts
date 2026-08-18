export interface LatLon {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in meters (Haversine). */
export function haversineMeters(a: LatLon, b: LatLon): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Parses `"49.7596, 6.6439"` (also without the space) into coordinates.
 * Returns null for anything that is not a plain lat,lon pair.
 */
export function parseCoordinates(input: string): LatLon | null {
  const match =
    /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(input);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!isValidLatLon(lat, lon)) return null;
  return { lat, lon };
}

export function isValidLatLon(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/** `1234` → `"1.2 km"`, `850` → `"850 m"`. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return 'unknown';
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/** `5400` → `"1 h 30 min"`, `90` → `"2 min"`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'unknown';
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Rounds a coordinate to 5 decimals (~1 m) to keep responses compact. */
export function roundCoord(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}
