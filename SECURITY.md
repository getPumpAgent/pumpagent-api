# Security & Trust

## Non-Custodial Architecture

PumpAgent never holds user funds.
Every swap returns an unsigned serialized transaction.
Users sign with their own wallet.
PumpAgent has zero access to private keys.

## Fee Transparency

Fee: 0.5% via Jupiter referral program
Fee wallet: `JAL73tnRravjWQqm7yPkw6wzhhxx9v6NZ5jNt1pjKJau`
Verify all collected fees: https://solscan.io/account/JAL73tnRravjWQqm7yPkw6wzhhxx9v6NZ5jNt1pjKJau
Fee injection code: `src/routes/swap.ts` (open source, auditable)

## MEV Protection

All swaps route through Jupiter V2.
Jupiter Z RFQ fills bypass the public mempool entirely.
Sandwich attacks not possible on RFQ routed swaps.

## Infrastructure

Primary RPC: Helius (enterprise grade)
Fallback RPC: Solana public mainnet
Both endpoints verified before every request.

## Open Source

All code: https://github.com/getPumpAgent/pumpagent-api
License: MIT
Anyone can audit, fork, or contribute.

## Responsible Disclosure

Found a security issue?
Open a GitHub issue marked `[SECURITY]`
or email via GitHub profile.
