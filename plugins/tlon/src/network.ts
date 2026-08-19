import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import {
  Agent,
  fetch as undiciFetch,
  type RequestInfo as UndiciRequestInfo,
  type RequestInit as UndiciRequestInit,
} from "undici";

type LookupAll = (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>;

export interface PinnedOriginFetch {
  fetch: typeof fetch;
  close(): Promise<void>;
}

export function publicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6") {
    const ipv6 = parsed as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) parsed = ipv6.toIPv4Address();
  }
  return parsed.range() === "unicast";
}

function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = options.family ?? 0;
    const eligible =
      family === 4 || family === 6 ? addresses.filter((address) => address.family === family) : addresses;
    if (!eligible.length) {
      const error = new Error(`Tlon ship has no public IPv${family || 4}/IPv6 address`) as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      callback(error, "", 0);
      return;
    }
    if (options.all) callback(null, eligible);
    else callback(null, eligible[0]!.address, eligible[0]!.family);
  };
}

export async function createPinnedOriginFetch(
  baseUrl: string,
  lookupFn: LookupAll = lookup,
): Promise<PinnedOriginFetch> {
  const origin = new URL(baseUrl).origin;
  const hostname = new URL(origin).hostname;
  const addresses = await lookupFn(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((address) => !publicAddress(address.address))) {
    throw new Error("Tlon ship URL must resolve only to public network addresses");
  }
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup(addresses) }, allowH2: false });
  const guardedFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestInit = { ...init, dispatcher } as unknown as UndiciRequestInit;
    return (await undiciFetch(input as unknown as UndiciRequestInfo, requestInit)) as unknown as Response;
  }) as typeof fetch;
  return {
    fetch: guardedFetch,
    close: () => dispatcher.close(),
  };
}
