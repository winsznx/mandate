/**
 * The independent verifier.
 *
 *     pnpm verify:trial   <receiptId>
 *     pnpm verify:mandate <mandateId>
 *
 * Run through `tsx`, which the root scripts already do. The `.js` specifiers in
 * these imports are the TypeScript convention for NodeNext resolution and are
 * not resolvable by bare `node` against the sources, so there is deliberately no
 * `bin` entry pointing at this file.
 *
 * Everything it needs is an id and a chain RPC. There is no MANDATE API base
 * URL to configure and no database connection to hold, by construction rather
 * than by convention: nothing in this package can reach one.
 *
 * Exit codes are the verdict, so the command composes into a CI gate:
 * 0 VERIFIED, 1 FAILED, 2 PARTIALLY VERIFIED, 3 STALE, 64 usage error.
 */
import { createClient, ConfigurationError, resolveTarget } from "./config.js";
import { exitCodeFor, renderJson, renderReport } from "./report.js";
import { verifyMandate, verifyTrial } from "./verify.js";

const USAGE = `mandate verifier

  verify:trial   <receiptId>   check a published trial receipt
  verify:mandate <mandateId>   check a mandate, its grant and its executions

options
  --chain <id>          chain to read (default 97, BSC testnet)
  --rpc <url>           RPC endpoint (default: the chain's public node)
  --registry <address>  MandateReceiptRegistry address
                        (default: contracts/deployments/<chainId>.json)
  --disclosure <uri>    mandate disclosure document: the granted AuthorityIR,
                        the session key and the execution transactions. Checked
                        against the on-chain hashes before any of it is used.
  --at <unixSeconds>    evaluate freshness at this time instead of now
  --json                machine-readable output
  --verbose             print the values each step compared

environment
  MANDATE_RPC_URL, MANDATE_CHAIN_ID, MANDATE_REGISTRY_ADDRESS
  MANDATE_R2_PUBLIC_BASE   public base URL for r2:// evidence objects
  MANDATE_IPFS_GATEWAY     gateway for ipfs:// evidence objects
`;

interface ParsedArgs {
  command: "trial" | "mandate";
  id: string;
  chainId?: number | undefined;
  rpcUrl?: string | undefined;
  registry?: string | undefined;
  disclosureUri?: string | undefined;
  now?: number | undefined;
  json: boolean;
  verbose: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command !== "trial" && command !== "mandate") {
    throw new UsageError(`expected "trial" or "mandate", received "${command ?? ""}"`);
  }

  const positional: string[] = [];
  const flags = new Map<string, string>();
  const bare = new Set<string>();

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name === "json" || name === "verbose") {
      bare.add(name);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`--${name} needs a value`);
    }
    flags.set(name, value);
    index += 1;
  }

  const id = positional[0];
  if (id === undefined) throw new UsageError(`${command} needs an id`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) {
    throw new UsageError(`"${id}" is not a 32-byte id`);
  }

  const chain = flags.get("chain");
  const at = flags.get("at");

  return {
    command,
    id: id.toLowerCase(),
    ...(chain === undefined ? {} : { chainId: Number(chain) }),
    ...(flags.has("rpc") ? { rpcUrl: flags.get("rpc") } : {}),
    ...(flags.has("registry") ? { registry: flags.get("registry") } : {}),
    ...(flags.has("disclosure") ? { disclosureUri: flags.get("disclosure") } : {}),
    ...(at === undefined ? {} : { now: Number(at) }),
    json: bare.has("json"),
    verbose: bare.has("verbose"),
  };
}

async function main(): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 64;
    }
    throw error;
  }

  const target = resolveTarget({
    chainId: args.chainId,
    rpcUrl: args.rpcUrl,
    registry: args.registry,
  });
  const client = await createClient(target);

  const options = {
    target,
    client,
    now: args.now ?? Math.floor(Date.now() / 1000),
    disclosureUri: args.disclosureUri,
  };

  const report =
    args.command === "trial"
      ? await verifyTrial(args.id as `0x${string}`, options)
      : await verifyMandate(args.id as `0x${string}`, options);

  process.stdout.write(
    `${args.json ? renderJson(report) : renderReport(report, { verbose: args.verbose })}\n`,
  );
  return exitCodeFor(report.verdict);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // A configuration problem is the operator's, not the publisher's, so it is
    // never reported as a failed verification.
    const message = error instanceof ConfigurationError ? error.message : String(error);
    process.stderr.write(`verifier could not run: ${message}\n`);
    process.exitCode = 64;
  });
