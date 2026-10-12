import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { TargetUrlRejectedError } from "../../../application/extract-page/errors.js";

export const assertPublicHttpUrl = async (
  value: string,
  hostCache: Map<string, Promise<void>> = new Map(),
): Promise<URL> => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TargetUrlRejectedError("A valid absolute URL is required.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TargetUrlRejectedError("Only HTTP and HTTPS URLs are supported.");
  }
  if (url.username || url.password) {
    throw new TargetUrlRejectedError("URLs with embedded credentials are not allowed.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new TargetUrlRejectedError("Local network destinations are not allowed.");
  }

  const cachedLookup = hostCache.get(hostname);
  if (cachedLookup) {
    await cachedLookup;
    return url;
  }

  const validation = (async () => {
    const addresses = isIP(hostname)
      ? [hostname]
      : (await lookup(hostname, { all: true, verbatim: true })).map(
          (entry) => entry.address,
        );
    if (addresses.length === 0) {
      throw new TargetUrlRejectedError("The destination host has no public address.");
    }

    for (const address of addresses) {
      try {
        if (ipaddr.process(address).range() !== "unicast") {
          throw new TargetUrlRejectedError(
            "Local, private, and reserved network destinations are not allowed.",
          );
        }
      } catch (error) {
        if (error instanceof TargetUrlRejectedError) throw error;
        throw new TargetUrlRejectedError("The destination host is not a public IP address.");
      }
    }
  })();

  hostCache.set(hostname, validation);
  try {
    await validation;
  } catch (error) {
    hostCache.delete(hostname);
    if (error instanceof TargetUrlRejectedError) throw error;
    throw new TargetUrlRejectedError("The destination host could not be resolved safely.");
  }
  return url;
};
