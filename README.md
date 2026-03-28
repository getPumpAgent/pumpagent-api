<h1 align="center">PumpAgent API</h1>

<p align="center"><strong>The PumpFun Trading Terminal API</strong></p>
<p align="center">Smart money signals. One-click swaps. Portfolio tracking. Free.</p>

<p align="center">
  <a href="https://pumpapi.markets/swap">Terminal</a> &middot;
  <a href="https://pumpapi.markets/developers">Docs</a> &middot;
  <a href="https://www.npmjs.com/package/getpumpagent">npm</a> &middot;
  <a href="https://t.me/PumpAgentSignals">Telegram Signals</a>
</p>

<br>

## Quick Start

```bash
npm install getpumpagent
```

```typescript
import { PumpAgent } from 'getpumpagent'

const agent = new PumpAgent()

// Get newest PumpFun launches
const { tokens } = await agent.tokens.new()

// Swap SOL for a token
const swap = await agent.swap({
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: tokens[0].mint,
  amount: 100000000, // 0.1 SOL in lamports
  userWallet: 'YOUR_WALLET',
  jito: true,
  priorityLevel: 'medium'
})
```

<br>

## API Endpoints

Base URL: `https://api.pumpapi.markets`

### Tokens

| Endpoint | Description |
|---|---|
| `GET /v1/tokens/new` | Latest PumpFun launches from Helius |
| `GET /v1/tokens/trending` | Trending Solana pairs via DexScreener |
| `GET /v1/tokens/graduating` | Tokens nearing bonding curve graduation |
| `GET /v1/tokens/boosted` | DexScreener boosted tokens |
| `GET /v1/tokens/search?q=` | Search tokens |
| `GET /v1/tokens/:address` | Token detail — price, mcap, volume, risk, KOL signal |
| `GET /v1/tokens/:address/risk` | Risk score — holder concentration, creator activity |
| `GET /v1/tokens/:address/signals` | Trading signals — momentum, buy pressure, RSI, trend |
| `GET /v1/tokens/:address/ohlcv?interval=` | OHLCV candles via GeckoTerminal (1m, 5m, 1h, 1d) |
| `GET /v1/tokens/:address/holders` | Top holders and concentration |
| `GET /v1/tokens/:address/txns` | Recent transactions |

### Intelligence

| Endpoint | Description |
|---|---|
| `GET /v1/picks?type=momentum` | Current momentum pick |
| `GET /v1/picks?type=degen` | High-conviction degen pick |
| `GET /v1/picks?type=smartmoney` | KOL-tracked tokens (smart money) |
| `GET /v1/picks?type=graduating` | Active graduation candidates |
| `GET /v1/picks?type=hot` | Top gainers by multiplier |

### Trading

| Endpoint | Description |
|---|---|
| `POST /v1/swap` | Build unsigned swap transaction (Jupiter Ultra) |
| `POST /v1/swap/send` | Submit signed transaction via Helius Sender |
| `GET /v1/swap/status/:signature` | Check transaction confirmation status |

### Portfolio

| Endpoint | Description |
|---|---|
| `GET /v1/portfolio/:wallet` | Wallet portfolio — SOL balance, token holdings, USD values |

### Market

| Endpoint | Description |
|---|---|
| `GET /v1/market/stats` | Market sentiment, top gainers, most active |
| `GET /v1/kol/activity` | KOL wallet activity |
| `GET /v1/kol/leaderboard` | KOL leaderboard by win rate |
| `GET /v1/narratives/trending` | Trending narratives/themes |

### Referral

| Endpoint | Description |
|---|---|
| `POST /v1/referral/register` | Register as referrer (self-service) |
| `PUT /v1/referral/wallet` | Add/update payout wallet |
| `GET /v1/referral/stats/:ref` | Referrer stats and swap history |
| `GET /v1/referral/leaderboard` | Top referrers |
| `POST /v1/referral/track` | Track a referred swap |

<br>

## Trading Signals

`GET /v1/tokens/:address/signals` returns real-time trading signals with two modes:

**Bonding Curve** (pre-graduation on PumpFun):
- Volume spike detection
- Buy/sell pressure ratio
- 5m momentum

**Graduated** (on PumpSwap/Raydium):
- All bonding curve signals plus:
- RSI (14-period on 5m candles)
- Price position in recent range

```json
{
  "mode": "graduated",
  "signals": {
    "volSpike": 2.3,
    "momentum": 12.5,
    "buyPressure": 0.72,
    "trend": 8.1,
    "activity": 45,
    "rsi": 62.3,
    "pricePosition": 78
  },
  "interpretation": {
    "overall": "strong",
    "confidence": 80,
    "reason": "Strong buying pressure with positive momentum"
  }
}
```

<br>

## Risk Scoring

`GET /v1/tokens/:address/risk` analyzes on-chain data:

- Top holder concentration (via `getTokenLargestAccounts`)
- Top 5 holder distribution
- Token age and metadata quality
- Liquidity depth
- Creator wallet sell activity

Returns score 0-100 with tier: `safe` | `moderate` | `risky` | `dangerous`

<br>

## Telegram Signals

Real-time alerts to [@PumpAgentSignals](https://t.me/PumpAgentSignals):

- Multi-source signal scoring (momentum, KOL activity, DexScreener boosts)
- 4 rotating alert formats
- 30-minute followup on 50%+ gainers
- Deep links to terminal with token pre-selected
- Max 8 alerts/hour, 5 min cooldown, 3-hour dedup

<br>

## Trading Terminal

Live at [pumpapi.markets/swap](https://pumpapi.markets/swap):

- Token feed with 6 tabs (Momentum, Degen, Graduating, Smart Money, Hot, Fresh)
- DexScreener chart embed
- Jupiter swap widget with preset amounts
- Referral tracking
- Deep link support: `/swap?token=MINT_ADDRESS`

<br>

## Architecture

- **Runtime**: Node.js + Fastify + TypeScript
- **RPC**: Helius (DAS API, parsed transactions)
- **Swaps**: Jupiter Ultra API
- **MEV Protection**: Helius Sender (Jito routing)
- **Charts**: GeckoTerminal OHLCV
- **Market Data**: DexScreener
- **Database**: SQLite (referrals, telegram dedup)
- **Alerts**: Telegram Bot API

<br>

## Pricing

Free. 0.5% swap fee only.

Fee wallet: [`JAL73tnR...pjKJau`](https://solscan.io/account/JAL73tnRravjWQqm7yPkw6wzhhxx9v6NZ5jNt1pjKJau) — every fee on-chain, verifiable.

<br>

## Links

[Terminal](https://pumpapi.markets/swap) &middot; [Docs](https://pumpapi.markets/developers) &middot; [npm](https://www.npmjs.com/package/getpumpagent) &middot; [Telegram](https://t.me/PumpAgentSignals) &middot; [Twitter](https://x.com/getpumpagent)

Built by [@Niconomics](https://x.com/Niconomics)

<sub>ISC License</sub>
