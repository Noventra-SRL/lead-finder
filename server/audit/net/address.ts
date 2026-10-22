import { BlockList, isIP } from 'node:net';

/*
 * Destinazioni di rete ammesse per l'audit dei siti (protezione SSRF).
 * Si possono contattare solo indirizzi IP pubblici. Sono bloccati, per IPv4 e IPv6:
 *  - "questa rete", loopback, reti private (RFC 1918), CGNAT (100.64/10), link-local (169.254/16, dove stanno anche
 *    i servizi di metadati dei cloud come 169.254.169.254), multicast, riservati, broadcast;
 *  - reti di documentazione e di test (192.0.2/24, 198.51.100/24, 203.0.113/24, 198.18/15, 2001:db8::/32);
 *  - IPv6 locali (::1, fc00::/7, fe80::/10, fec0::/10), multicast (ff00::/8), scarto (100::/64), Teredo (2001::/32),
 *    ORCHID (2001:10::/28, 2001:20::/28);
 *  - indirizzi IPv6 che incorporano un IPv4 (::ffff:a.b.c.d, 64:ff9b::/96, 2002::/16): si valuta l'IPv4 incorporato.
 * Anche i nomi host locali (localhost, *.local, *.internal, metadata.google.internal…) sono rifiutati prima del DNS.
 */

const blocked = new BlockList();
const v4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
for (const [net, prefix] of v4) blocked.addSubnet(net, prefix, 'ipv4');
const v6: [string, number][] = [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001::', 32],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];
for (const [net, prefix] of v6) blocked.addSubnet(net, prefix, 'ipv6');

const BLOCKED_HOSTNAMES =
  /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|arpa|invalid|test|onion)$/i;
const METADATA_HOSTNAMES = new Set(['metadata.google.internal', 'metadata', 'instance-data', 'metadata.azure.com']);

/** IPv4 incorporato in un IPv6 (mappato, NAT64, 6to4), se presente. */
function embeddedIPv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const mapped =
    /^(?:0{0,4}:){0,5}(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(lower) ?? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return mapped[1]!;
  const hex = expandIPv6(lower);
  if (!hex) return null;
  const toV4 = (a: number, b: number) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  // ::ffff:aabb:ccdd (mappato in forma esadecimale)
  if (hex.slice(0, 5).every((x) => x === 0) && hex[5] === 0xffff) return toV4(hex[6]!, hex[7]!);
  // 64:ff9b::/96 (NAT64)
  if (hex[0] === 0x64 && hex[1] === 0xff9b && hex.slice(2, 6).every((x) => x === 0)) return toV4(hex[6]!, hex[7]!);
  // 2002::/16 (6to4): IPv4 nei 32 bit successivi
  if (hex[0] === 0x2002) return toV4(hex[1]!, hex[2]!);
  return null;
}

function expandIPv6(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let s = ip.split('%')[0]!;
  if (s.includes('.')) {
    const v4part = s.slice(s.lastIndexOf(':') + 1);
    const p = v4part.split('.').map(Number);
    s = `${s.slice(0, s.lastIndexOf(':') + 1)}${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array(fill).fill('0'), ...t];
  if (parts.length !== 8) return null;
  return parts.map((x) => parseInt(x || '0', 16));
}

/** L'indirizzo IP è pubblico e quindi contattabile. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, 'ipv4');
  if (family === 6) {
    const inner = embeddedIPv4(ip);
    if (inner) return isIP(inner) === 4 && !blocked.check(inner, 'ipv4');
    return !blocked.check(ip.split('%')[0]!, 'ipv6');
  }
  return false;
}

/** Il nome host è ammissibile prima ancora di risolverlo (nessun nome locale o di metadati). */
export function isAllowedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h || METADATA_HOSTNAMES.has(h) || BLOCKED_HOSTNAMES.test(h)) return false;
  // un IP scritto direttamente nell'URL è ammesso solo se pubblico (le forme numeriche strane sono già normalizzate da URL)
  const bare = h.replace(/^\[|\]$/g, '');
  if (isIP(bare)) return isPublicAddress(bare);
  return h.includes('.');
}
