import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { bscTestnet } from "./chains";
import { DEFAULT_RPC_URL, rpcUrl } from "../proof/config";

// WalletConnect Project ID for RainbowKit
const projectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "3a6bad1d73b060227dcd7d4100000000";

export const config = getDefaultConfig({
  appName: "MANDATE",
  projectId,
  chains: [bscTestnet],
  transports: {
    [bscTestnet.id]: http(rpcUrl() || DEFAULT_RPC_URL),
  },
  ssr: true,
});
