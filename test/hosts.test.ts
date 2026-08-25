/**
 * Tests for the host classifier.
 *
 * It is shared verbatim across these MCP servers so that one host is judged the
 * same way everywhere; in this one it decides whether the plain-http warning
 * applies to the configured URL. The IPv4-mapped and root-label cases are the
 * spellings that defeat a string comparison, which is what this replaced.
 */
import { describe, expect, it } from 'vitest';

import { internalHostKind } from '../src/hosts.js';

/** What `new URL(...).hostname` yields, brackets and all. */
function hostnameOf(url: string): string {
  return new URL(url).hostname;
}

describe('internalHostKind', () => {
  it.each([
    ['http://127.0.0.1/x', 'loopback'],
    ['http://127.42.9.1/x', 'loopback'],
    ['http://0.0.0.0/x', 'loopback'],
    ['http://localhost:8080/x', 'loopback'],
    ['http://admin.localhost/x', 'loopback'],
    ['http://[::1]/x', 'loopback'],
    ['http://[::]/x', 'loopback'],
    ['http://169.254.169.254/latest/meta-data/', 'link-local'],
    ['http://[fe80::1]/x', 'link-local'],
    ['http://[febf::1]/x', 'link-local'],
    // URL rewrites an IPv4-mapped literal into hex before any check sees it,
    // and a dual-stack client dials the address it carries.
    ['http://[::ffff:127.0.0.1]/x', 'loopback'],
    ['http://[::ffff:169.254.169.254]/x', 'link-local'],
    ['http://[0:0:0:0:0:ffff:7f00:1]/x', 'loopback'],
    ['http://[::127.0.0.1]/x', 'loopback'],
    ['http://[::ffff:0:169.254.169.254]/x', 'link-local'],
    ['http://[64:ff9b::169.254.169.254]/x', 'link-local'],
    // The root label makes the same name look different.
    ['http://localhost./x', 'loopback'],
    ['http://LOCALHOST/x', 'loopback'],
    // Decimal, octal and hex spellings of the same address; URL normalises
    // these itself, which is why the classifier only has to handle the result.
    ['http://2130706433/x', 'loopback'],
    ['http://0177.0.0.1/x', 'loopback'],
    ['http://127.1/x', 'loopback'],
    // Names that resolve to the metadata service on an instance and nowhere else.
    ['http://metadata.google.internal/computeMetadata/v1/', 'link-local'],
    ['http://instance-data/latest/meta-data/', 'link-local'],
  ])('classifies %s as %s', (url, kind) => {
    expect(internalHostKind(hostnameOf(url))).toBe(kind);
  });

  it.each([
    'http://192.168.1.50/x',
    'http://10.0.0.5/x',
    'http://172.16.4.4/x',
    'http://[fc00::1]/x',
    'https://example.com/x',
    'https://1.1.1.1/x',
    'https://[2606:4700::1111]/x',
    'https://127.0.0.1.example.com/x',
    'https://notlocalhost/x',
  ])('leaves %s alone', (url) => {
    expect(internalHostKind(hostnameOf(url))).toBeNull();
  });

  // `URL` always emits the compressed hex form, but the classifier takes a
  // hostname from anywhere, and these are the spellings a resolver hands back.
  it.each([
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['::127.0.0.1', 'loopback'],
    ['0:0:0:0:0:ffff:a9fe:a9fe', 'link-local'],
    ['[::ffff:127.0.0.1]', 'loopback'],
    ['FE80::1', 'link-local'],
    ['METADATA.GOOGLE.INTERNAL.', 'link-local'],
  ])('classifies the bare literal %s as %s', (host, kind) => {
    expect(internalHostKind(host)).toBe(kind);
  });

  // Metadata endpoints that no range check reaches: Alibaba answers in
  // carrier-grade NAT space, Oracle's legacy endpoint in IETF assignment space.
  it.each([
    ['http://100.100.100.200/latest/meta-data/', 'link-local'],
    ['http://192.0.0.192/latest/', 'link-local'],
  ])('classifies the metadata endpoint %s as %s', (url, kind) => {
    expect(internalHostKind(hostnameOf(url))).toBe(kind);
  });

  // A scope id belongs to the interface, not the address. `isIP` accepts it, so
  // leaving it on would desynchronise the dotted-quad fold from what isIP just
  // agreed was an address.
  it.each([
    ['::ffff:127.0.0.1%lo', 'loopback'],
    ['::ffff:169.254.169.254%eth0', 'link-local'],
    ['fe80::1%eth0', 'link-local'],
    ['::%lo', 'loopback'],
  ])('classifies %s as %s despite the scope id', (host, kind) => {
    expect(internalHostKind(host)).toBe(kind);
  });

  it.each([
    '::ffff:1.1.1.1',
    '2606:4700:4700::1111',
    'not a host at all',
    '',
    '1:2:3:4:5:6:7:8:9',
  ])('leaves the bare literal %j alone', (host) => {
    expect(internalHostKind(host)).toBeNull();
  });
});
