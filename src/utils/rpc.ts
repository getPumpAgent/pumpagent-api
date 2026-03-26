import { Connection } from "@solana/web3.js";
import { createLogger } from "./logger.js";

const log = createLogger("rpc");

const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL!;
const FALLBACK_RPC_URL =
  process.env.FALLBACK_RPC_URL || "https://api.mainnet-beta.solana.com";

let connection: Connection | null = null;
let usingFallback = false;

export function getConnection(): Connection {
  if (connection) return connection;

  if (HELIUS_RPC_URL) {
    connection = new Connection(HELIUS_RPC_URL, "confirmed");
    log.info("Connected to Helius RPC");
  } else {
    connection = new Connection(FALLBACK_RPC_URL, "confirmed");
    usingFallback = true;
    log.warn("Helius RPC not configured, using fallback");
  }

  return connection;
}

export async function getConnectionWithFallback(): Promise<Connection> {
  if (usingFallback && connection) return connection;

  const conn = getConnection();

  try {
    await conn.getSlot();
    return conn;
  } catch {
    log.warn("Helius RPC failed, switching to fallback");
    connection = new Connection(FALLBACK_RPC_URL, "confirmed");
    usingFallback = true;
    return connection;
  }
}
