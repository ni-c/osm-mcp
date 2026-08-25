import { isIP } from 'node:net';

/**
 * Why a host is only reachable from the machine it is named on: `loopback`
 * addresses that machine itself, `link-local` covers 169.254/16, fe80::/10 and
 * the handful of addresses cloud providers put their metadata service on.
 */
export type InternalHostKind = 'loopback' | 'link-local';

/**
 * Names for the cloud metadata service, which resolve on an instance and
 * nowhere else.
 */
const METADATA_NAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);

/**
 * Metadata endpoints that sit outside 169.254/16.
 *
 * Alibaba Cloud answers on 100.100.100.200, which is carrier-grade NAT space,
 * and Oracle's legacy endpoint is 192.0.0.192, which is IETF protocol
 * assignments. Neither is link-local by address, but both are the same thing by
 * purpose, and neither is somewhere a legitimate target lives.
 */
const METADATA_ADDRESSES = new Set(['100.100.100.200', '192.0.0.192']);

/**
 * Classifies a hostname that addresses the machine itself, its link-local
 * range, or a cloud metadata service — or returns null for anything routable.
 *
 * It does the job numerically rather than by comparing strings, because the
 * spellings differ more than they look. `URL` canonicalises an IPv4-mapped IPv6
 * literal into hex — `http://[::ffff:127.0.0.1]/` arrives here as
 * `[::ffff:7f00:1]` — while every dual-stack client dials it as plain
 * 127.0.0.1, and `localhost.` with its root label is the same name as
 * `localhost`. String comparison misses both.
 *
 * Takes a hostname from anywhere, not only from `URL`: a resolver hands back
 * `::ffff:127.0.0.1` in dotted form and may attach a `%zone` suffix, so both
 * are handled here rather than assumed away.
 */
export function internalHostKind(hostname: string): InternalHostKind | null {
  const host = bareHost(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (METADATA_NAMES.has(host)) return 'link-local';
  if (METADATA_ADDRESSES.has(host)) return 'link-local';

  const version = isIP(host);
  if (version === 4) return ipv4Kind(host.split('.').map(Number));
  if (version !== 6) return null;

  const groups = expandIpv6(host);
  if (groups === null) return null;
  const explicit = ipv6Kind(groups);
  if (explicit !== null) return explicit;
  const embedded = embeddedIpv4(groups);
  return embedded === null ? null : ipv4Kind(embedded);
}

function bareHost(hostname: string): string {
  return (
    hostname
      .toLowerCase()
      // URL.hostname keeps the brackets around an IPv6 literal, so a bare '::1'
      // would never match.
      .replace(/^\[|]$/g, '')
      // A scope id belongs to the interface, not to the address. `isIP` accepts
      // it, so leaving it on would desynchronise every check below from what
      // `isIP` just agreed was an address.
      .replace(/%.*$/, '')
      // 'localhost.' is the same name as 'localhost' — the root label is what
      // makes it fully qualified, not a different host.
      .replace(/\.+$/, '')
  );
}

/** Expands an IPv6 literal into its eight 16-bit groups. */
function expandIpv6(address: string): number[] | null {
  let text = address;
  // A literal may end in dotted-quad notation (::ffff:127.0.0.1). Fold that tail
  // into the two hex groups it stands for so the rest of this is uniform.
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted !== null) {
    const [a = 0, b = 0, c = 0, d = 0] = (dotted[1] ?? '')
      .split('.')
      .map(Number);
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    text = `${text.slice(0, dotted.index)}:${high}:${low}`;
  }

  const [head = '', tail] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined ? null : tail === '' ? [] : tail.split(':');
  if (right === null) return toGroups(left);
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return toGroups([...left, ...Array<string>(missing).fill('0'), ...right]);
}

function toGroups(groups: string[]): number[] | null {
  if (groups.length !== 8) return null;
  // Tested rather than left to `parseInt`, which stops at the first character it
  // does not like and returns a number for '7f00xyz' just as happily.
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

/**
 * Extracts the IPv4 address an IPv6 literal carries, for the prefixes whose
 * whole purpose is to stand in for one.
 */
function embeddedIpv4(groups: number[]): number[] | null {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = groups;
  const carriesIpv4 =
    // ::a.b.c.d (IPv4-compatible) and ::ffff:a.b.c.d (IPv4-mapped, RFC 4291).
    ((a | b | c | d | e) === 0 && (f === 0 || f === 0xffff)) ||
    // ::ffff:0:a.b.c.d — IPv4-translated (RFC 2765).
    ((a | b | c | d) === 0 && e === 0xffff && f === 0) ||
    // 64:ff9b::a.b.c.d — the well-known NAT64 prefix (RFC 6052).
    (a === 0x64 && b === 0xff9b && (c | d | e | f) === 0);
  return carriesIpv4 ? [g >> 8, g & 0xff, h >> 8, h & 0xff] : null;
}

function ipv4Kind(octets: number[]): InternalHostKind | null {
  const [a = 0, b = 0] = octets;
  // 0.0.0.0/8 ('this host', RFC 1122) and 127/8 both reach the machine itself.
  if (a === 0 || a === 127) return 'loopback';
  // 169.254/16, which holds 169.254.169.254 — the AWS/GCP/Azure metadata service.
  if (a === 169 && b === 254) return 'link-local';
  return null;
}

function ipv6Kind(groups: number[]): InternalHostKind | null {
  // `::` and `::1` are also caught by the IPv4-compatible unwrapping below, but
  // they are named here so that removing that unwrapping cannot silently take
  // the two most obvious loopback literals with it.
  if (groups.every((group) => group === 0)) return 'loopback'; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return 'loopback'; // ::1
  }
  if (((groups[0] ?? 0) & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
  return null;
}
