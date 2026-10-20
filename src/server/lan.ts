import { networkInterfaces } from "node:os";

const MAPPED_IPV4_PREFIX = "::ffff:";

function stripMappedPrefix(address: string): string {
  return address.toLowerCase().startsWith(MAPPED_IPV4_PREFIX) ? address.slice(MAPPED_IPV4_PREFIX.length) : address;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [first = 0, second = 0] = octets;
  return (
    first === 127 ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isPrivateIpv6(address: string): boolean {
  const lowered = address.toLowerCase();
  return lowered === "::1" || lowered.startsWith("fe80:") || lowered.startsWith("fc") || lowered.startsWith("fd");
}

export function isLocalNetworkAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const bare = stripMappedPrefix(address);
  return bare.includes(":") ? isPrivateIpv6(bare) : isPrivateIpv4(bare);
}

export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && isPrivateIpv4(entry.address))
    .map((entry) => entry.address);
}
