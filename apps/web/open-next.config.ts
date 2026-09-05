import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * The proof and marketplace pages are `force-dynamic` and read chain state on
 * every request, so there is nothing to incrementally cache. The default
 * (no cache adapter) is correct here — adding R2/KV incremental cache would
 * only add a layer that every page opts out of.
 */
export default defineCloudflareConfig();
