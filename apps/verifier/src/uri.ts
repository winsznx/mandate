/**
 * Turning an evidence URI into bytes.
 *
 * The receipt stores a location and a hash. Only the hash is trusted: the URI
 * is a hint about where a copy might be found, and any host that serves the
 * right bytes is as good as any other. That is what makes the storage layer
 * non-load-bearing — an `r2://` object served through a public bucket, an IPFS
 * gateway and a file on a judge's laptop are interchangeable, because the
 * caller checks all three against the same on-chain commitment.
 *
 * Fetching therefore has no notion of an authoritative MANDATE endpoint, sends
 * no credentials, and reads nothing from a MANDATE database.
 */

/** Public base URL for `r2://<bucket>/<key>` objects, e.g. an `https://pub-….r2.dev` domain. */
const R2_PUBLIC_BASE_ENV = "MANDATE_R2_PUBLIC_BASE";

/** Gateway used to dereference `ipfs://` CIDs. Any public gateway will do. */
const IPFS_GATEWAY_ENV = "MANDATE_IPFS_GATEWAY";
const DEFAULT_IPFS_GATEWAY = "https://ipfs.io/ipfs/";

const FETCH_TIMEOUT_MS = 30_000;
/** Refuse to buffer an unbounded body. A receipt's evidence is a JSON document, not a dataset. */
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;

export class EvidenceUnavailableError extends Error {
  readonly uri: string;

  constructor(uri: string, message: string) {
    super(message);
    this.name = "EvidenceUnavailableError";
    this.uri = uri;
  }
}

export interface FetchOptions {
  /** Overrides for the two environment-driven bases, so tests need no ambient state. */
  r2PublicBase?: string | undefined;
  ipfsGateway?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * Resolve a MANDATE evidence URI to something dereferenceable.
 *
 * `r2://` is not a fetchable scheme, so it is mapped through a public base URL.
 * Requiring that base to be supplied rather than hardcoding a MANDATE bucket
 * keeps the verifier honest: it will not silently reach for infrastructure the
 * operator controls.
 */
export function resolveEvidenceUri(uri: string, options: FetchOptions = {}): URL {
  if (uri.startsWith("https://") || uri.startsWith("http://") || uri.startsWith("file://")) {
    return new URL(uri);
  }

  if (uri.startsWith("ipfs://")) {
    const gateway = options.ipfsGateway ?? process.env[IPFS_GATEWAY_ENV] ?? DEFAULT_IPFS_GATEWAY;
    const path = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
    if (path.length === 0) throw new EvidenceUnavailableError(uri, "ipfs:// URI carries no CID");
    return new URL(path, gateway.endsWith("/") ? gateway : `${gateway}/`);
  }

  if (uri.startsWith("r2://")) {
    const base = options.r2PublicBase ?? process.env[R2_PUBLIC_BASE_ENV];
    if (base === undefined || base.length === 0) {
      throw new EvidenceUnavailableError(
        uri,
        `r2:// is not a dereferenceable scheme. Set ${R2_PUBLIC_BASE_ENV} to the bucket's public base URL, or pass an https:// mirror of the same bytes.`,
      );
    }
    const [bucket, ...keyParts] = uri.slice("r2://".length).split("/");
    if (bucket === undefined || keyParts.length === 0) {
      throw new EvidenceUnavailableError(uri, "r2:// URI must be r2://<bucket>/<key>");
    }
    // The public base already selects the bucket, so only the key is appended.
    // Joining the bucket again would produce a path no R2 domain serves.
    return new URL(keyParts.join("/"), base.endsWith("/") ? base : `${base}/`);
  }

  throw new EvidenceUnavailableError(uri, `unsupported URI scheme in "${uri}"`);
}

/**
 * Read the bytes an evidence URI points at.
 *
 * Returns raw bytes, never a parsed value. Parsing is the caller's job and must
 * happen after the hash check, so this function deliberately gives the caller
 * nothing it could be tempted to use early.
 */
export async function fetchEvidenceBytes(uri: string, options: FetchOptions = {}): Promise<Uint8Array> {
  const resolved = resolveEvidenceUri(uri, options);

  if (resolved.protocol === "file:") {
    const { readFile } = await import("node:fs/promises");
    try {
      return new Uint8Array(await readFile(resolved));
    } catch (error) {
      throw new EvidenceUnavailableError(uri, `cannot read ${resolved.pathname}: ${String(error)}`);
    }
  }

  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(resolved, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new EvidenceUnavailableError(uri, `request to ${resolved.href} failed: ${String(error)}`);
  }

  if (!response.ok) {
    throw new EvidenceUnavailableError(uri, `${resolved.href} returned HTTP ${response.status}`);
  }

  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAX_EVIDENCE_BYTES) {
    throw new EvidenceUnavailableError(
      uri,
      `evidence body is ${body.byteLength} bytes, above the ${MAX_EVIDENCE_BYTES}-byte ceiling`,
    );
  }
  return body;
}
