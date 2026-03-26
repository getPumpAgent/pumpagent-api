# Security

## Security & Trust Overview

PumpAgent API is a **read-only swap-building service** for Solana tokens. It constructs unsigned transactions via the Jupiter Ultra API and returns them to the caller for client-side signing. The server never has access to private keys, never custodies funds, and never submits transactions on behalf of users.

Every line of fee and swap logic is open source in this repository.

## Fee Transparency

A **0.5 % platform fee** (50 bps) is applied to each swap via Jupiter's built-in referral program. Fees are routed on-chain to:

| Field | Value |
|-------|-------|
| **Wallet** | `JAL73tnRravjWQqm7yPkw6wzhhxx9v6NZ5jNt1pjKJau` |
| **Solscan** | [View on Solscan](https://solscan.io/account/JAL73tnRravjWQqm7yPkw6wzhhxx9v6NZ5jNt1pjKJau) |
| **Fee rate** | 0.5 % (50 bps) |

The fee is declared in the Jupiter order payload (`referralFee` / `referralAccount`) and is fully visible in every returned transaction before the user signs.

## MEV Protection

PumpAgent API benefits from Jupiter's built-in MEV protections:

- **Jupiter Ultra / V2** uses optimised routing and transaction construction that minimises MEV exposure by default.
- **Jupiter Z (RFQ system)** — when the Ultra API routes through Jupiter Z, trades are filled by market makers off-chain via a Request-for-Quote model. These fills **bypass the public mempool entirely**, making sandwich attacks impossible for those orders.

No additional MEV configuration is required by the caller.

## Fund Safety

PumpAgent API **never holds or controls user funds**:

1. The API returns an **unsigned transaction** (base64-encoded).
2. The caller's client **signs the transaction locally** with their own private key.
3. The caller (or their client) **submits the signed transaction** to the Solana network.

At no point does the server receive, store, or have access to private keys or seed phrases. There is no custody risk.

## Open Source Audit

All fee injection and swap logic is contained in a single file:

[`src/routes/swap.ts`](src/routes/swap.ts)

Key audit points:
- **Line 53** — `PLATFORM_FEE_BPS = 50` defines the 0.5 % fee.
- **Lines 62-63** — `referralFee` and `referralAccount` are passed to Jupiter's order endpoint.
- **Lines 96-112** — The full response, including fee details, is returned transparently to the caller.

We encourage anyone to review this file and verify that no hidden fees or unexpected behaviour exist.

## Responsible Disclosure

If you discover a security vulnerability, please report it responsibly:

- **Email:** security@pumpagent.fun

Please **do not** open a public GitHub issue for security vulnerabilities. We will acknowledge receipt within 48 hours and aim to provide a fix or mitigation plan within 7 days.

## Infrastructure

PumpAgent API relies on battle-tested third-party providers:

| Component | Provider | Purpose |
|-----------|----------|---------|
| **RPC** | [Helius](https://helius.dev) | Solana RPC access |
| **Swap routing** | [Jupiter V2 / Ultra](https://docs.jup.ag) | On-chain swap routing, MEV protection, and RFQ fills |

Both Helius and Jupiter are widely adopted across the Solana ecosystem and undergo continuous security review by their respective teams.
