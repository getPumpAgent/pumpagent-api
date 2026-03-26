<h1 align="center">PumpAgent</h1>

<p align="center"><strong>The trading API your agent deserves.</strong></p>

<br>

PumpFun swaps, token discovery, and MEV protection in one call. Open source. Non-custodial. Built for autonomous agents.

```bash
curl -X POST https://api.pumpapi.markets/v1/swap \
  -d '{"inputMint":"So1...","outputMint":"pump...","amount":1000000,"userWallet":"You..."}'
# → unsigned tx, 0.5% fee, MEV-protected, ready to sign
```

<br>

## Install

```bash
npm install getpumpagent
```

```typescript
import { PumpAgent } from 'getpumpagent'

const agent = new PumpAgent()
const { tokens } = await agent.tokens.new()
const swap = await agent.swap({
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: 'TOKEN_ADDRESS',
  amount: 100000000,
  userWallet: 'YOUR_WALLET'
})
```

<br>

## For AI Agents (Coming Soon)

MCP server launching soon. Drop this into your Cursor or Claude config:

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

> *"What are the newest PumpFun launches right now?"*
>
> *"Build me a swap for 0.1 SOL into [token]"*

MCP server in active development.

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

[Docs](https://api.pumpapi.markets) &nbsp;&middot;&nbsp; [npm](https://www.npmjs.com/package/getpumpagent) &nbsp;&middot;&nbsp; [Twitter](https://x.com/getpumpagent)

<br>

<sub>ISC License</sub>
