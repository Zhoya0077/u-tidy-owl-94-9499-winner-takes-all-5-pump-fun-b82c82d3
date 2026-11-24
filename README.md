# Pump.fun Replay Sprint Bot

[![make.fun](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![rank](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/Zhoya0077/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/rank.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![reward](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/Zhoya0077/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/reward.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)

A snipe-and-scalp trading bot for the make.fun **Winner Takes All — $5
Pump.fun Replay Sprint**. It trades 10 SOL of paper money on a replay of
Solana pump.fun bonding-curve data.

## Strategy

- **Strict entry:** a curve at least 300 slots old, with >= 1 SOL of net
  inflow from >= 5 distinct buyers over a 30-slot window, price up 8–50%
  and within 5% of the window high, real reserves 1–60 SOL. One fixed buy
  of 0.175 SOL per coin (capped at 1% of real reserves).
- **Runner exits:** sell the whole position at +50% take-profit, −8%
  stop-loss, a −35% trailing stop once up +15%, or a 2500-slot time limit.
- **Drawdown brake:** no new main entries past 35% equity drawdown.
- **Guardrail probes:** tiny 0.01 SOL round trips only late in the window
  when the traded-coin count lags the 25-coin target.
- Fully deterministic: no clock, no randomness.

## Local check

From the unpacked competition kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

## Verified dev grade (local, Node v24)

- Net PnL **+0.3414 SOL** (return +0.0341, 90% interval −0.404..+1.161 SOL)
- 255 fills over 128 coins, 128 round trips, win rate 0.195
- Max drawdown 0.0311, 1 rejected, 11 failed
- Guardrails met (128 coins hold a round trip >= 0.01 SOL)
- L1 regrade reproduced byte for byte (deterministic)

Honest note: the dev edge is fragile — the top 3 coins make 20% of the
gains, and a 20-copy stress test of the same design on reshuffled blocks
was negative on every copy (median −0.73 SOL). The final window is
different data; this entry is a live chance at the pot, not a lock.

## Layout

- `main.ts` — entry point, runs the strategy with `DEFAULT_PARAMS`
- `strategy.ts` — the strategy
- `vendor/makefun-bot.ts` — the kit's bot shim, copied byte for byte
