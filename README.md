<h1 align="center">PumpAgent</h1>

<p align="center"><strong>The trading API your agent deserves.</strong></p>

<br>

PumpFun swaps, token discovery, and MEV protection in one call. Open source. Non-custodial. Built for autonomous agents.

```bash
curl -X POST https://pumpapi.markets/v1/swap \
  -d '{"inputMint":"So1...","outputMint":"pump...","amount":1000000,"userWallet":"You..."}'
# → unsigned tx, 0.5% fee, MEV-protected, ready to sign
```

<br>

## For AI Agents

Drop this into your Cursor or Claude config:

```json
{
  "mcpServers": {
    "pumpagent": {
      "command": "npx",
      "args": ["getpumpagent"]
    }
  }
}
```

Then just ask:

> *"Buy the top KOL token from the last 10 minutes with 0.1 SOL"*

Your agent finds the token, builds the swap, and returns a sign-ready transaction. Autonomously.

<br>

## Features

**Instant swaps** — Jupiter V2 Ultra routing with auto slippage and Jito bundles.

**MEV-proof** — Jupiter Z RFQ fills bypass the mempool. Sandwich attacks don't apply.

**Zero custody** — We return an unsigned transaction. You sign it. We never touch your keys.

**Fully auditable** — One fee. One file. [`src/routes/swap.ts`](src/routes/swap.ts). Read every line.

<br>

## Pricing

Free during beta. 0.5% swap fee only.

Fee wallet: [`JAL73tnR...pjKJau`](https://solscan.io/account/JAL73tnRravjWQqm7yPkw6wzhhxx9v6NZ5jNt1pjKJau). Every fee, on-chain, verifiable.

<br>

[Docs](https://pumpapi.markets) &nbsp;&middot;&nbsp; [npm](https://www.npmjs.com/package/getpumpagent) &nbsp;&middot;&nbsp; [Twitter](https://x.com/getpumpagent)

<br>

<sub>ISC License</sub>
