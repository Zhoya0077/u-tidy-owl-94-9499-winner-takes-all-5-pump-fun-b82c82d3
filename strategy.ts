// Snipe-and-scalp bot for the pump.fun bonding-curve replay sprint.
//
// Idea: wait for a curve that is already moving on real inflow, ride the
// runner, and cut it fast when it turns. Strict entry, generous exits:
//   - enter only on >= 1 SOL of net inflow from >= 5 distinct buyers over
//     a 30-slot window, price up 8..50% and hugging the window high;
//   - one fixed stake, exits at +50% / -8% / -35% trailing once +15% /
//     2500-slot time limit; no fade or big-sell exits (they cut runners);
//   - a drawdown brake stops new main entries past 35% peak-to-trough;
//   - tiny 0.01 SOL probe round trips exist only to keep the coin count
//     above the guardrail bar late in the window.
// Deterministic: no clock, no randomness, insertion-ordered maps only.
// Position value = tokens * vq / (vt + tokens) * (1 - 0.0125) - tx fee.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface StrategyParams {
  window: number;
  minNetSol: number;
  minBuys: number;
  minBuyers: number;
  minPriceUp: number;
  maxPriceUp: number;
  nearHigh: number;
  minRqSol: number;
  maxRqSol: number;
  minAge: number;
  stakeSol: number;
  minBuySol: number;
  buySlipBps: number;
  takeProfit: number;
  stopLoss: number;
  trail: number;
  trailArm: number;
  fadeWindow: number;
  fadeNetSol: number;
  bigSellSol: number;
  maxHold: number;
  cooldown: number;
  maxEntries: number;
  maxMain: number;
  maxExposureSol: number;
  maxDrawdown: number;
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: StrategyParams = {
  window: 30,
  minNetSol: 1.0,
  minBuys: 5,
  minBuyers: 5,
  minPriceUp: 0.08,
  maxPriceUp: 0.5,
  nearHigh: 0.95,
  minRqSol: 1,
  maxRqSol: 60,
  minAge: 300,
  stakeSol: 0.175,
  minBuySol: 0.05,
  buySlipBps: 5000,
  takeProfit: 0.5,
  stopLoss: 0.08,
  trail: 0.35,
  trailArm: 0.15,
  fadeWindow: 15,
  fadeNetSol: 1000,
  bigSellSol: 1000,
  maxHold: 2500,
  cooldown: 200,
  maxEntries: 1,
  maxMain: 5,
  maxExposureSol: 2,
  maxDrawdown: 0.35,
  targetCoins: 25,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 2,
};

// ------------------------------------------------------------------ helpers

const BPS = 10000n;
const LAMPORTS = LAMPORTS_PER_SOL;

function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1_000_000_000));
}

/** Price is a ratio vq/vt; compare ratios with cross-multiplication. */
function ratioGte(aN: bigint, aD: bigint, bN: bigint, bD: bigint): boolean {
  return aN * bD >= bN * aD;
}

/** now >= start * (1 + frac), frac given in bps. */
function upAtLeast(nowN: bigint, nowD: bigint, startN: bigint, startD: bigint, bps: number): boolean {
  return nowN * startD * BPS >= startN * nowD * BigInt(BPS + BigInt(bps));
}

/** now <= start * (1 + frac), frac given in bps. */
function upAtMost(nowN: bigint, nowD: bigint, startN: bigint, startD: bigint, bps: number): boolean {
  return nowN * startD * BPS <= startN * nowD * BigInt(BPS + BigInt(bps));
}

/** now >= high * frac, frac given in bps. */
function atLeastFracOf(nowN: bigint, nowD: bigint, highN: bigint, highD: bigint, bps: number): boolean {
  return nowN * highD * BPS >= highN * nowD * BigInt(bps);
}

/** Mark-to-market value of a holding, net of curve fees and one tx fee. */
function positionValue(tokens: bigint, vq: bigint, vt: bigint, txFee: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return -txFee;
  const quote = (tokens * vq) / (vt + tokens);
  const curveFee = (quote * 125n) / BPS; // protocol 95 bps + creator 30 bps
  return quote - curveFee - txFee;
}

// ------------------------------------------------------------------ per-mint state

interface TradeRec {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: Pubkey;
  vq: bigint;
  vt: bigint;
}

interface MintTrack {
  createdSlot: number | null;
  complete: boolean;
  hist: TradeRec[];
  entries: number;
  lastExitSlot: number;
  everBought: boolean;
  probed: boolean;
  isProbe: boolean;
  pendingBuy: boolean;
  pendingSell: boolean;
  entrySlot: number;
  peakValue: bigint;
  armed: boolean;
}

function newTrack(): MintTrack {
  return {
    createdSlot: null,
    complete: false,
    hist: [],
    entries: 0,
    lastExitSlot: -1,
    everBought: false,
    probed: false,
    isProbe: false,
    pendingBuy: false,
    pendingSell: false,
    entrySlot: -1,
    peakValue: 0n,
    armed: false,
  };
}

// ------------------------------------------------------------------ strategy

export function createStrategy(p: StrategyParams): Bot {
  const tracks = new Map<Pubkey, MintTrack>();
  const trackOf = (mint: Pubkey): MintTrack => {
    let t = tracks.get(mint);
    if (t === undefined) {
      t = newTrack();
      tracks.set(mint, t);
    }
    return t;
  };

  const txFeeOf = (state: BotState): bigint => state.txFeeLamports();
  const minNetLamports = solToLamports(p.minNetSol);
  const stakeLamports = solToLamports(p.stakeSol);
  const minBuyLamports = solToLamports(p.minBuySol);
  const probeLamports = solToLamports(p.probeSol);
  const minRqLamports = solToLamports(p.minRqSol);
  const maxRqLamports = solToLamports(p.maxRqSol);
  const maxExposureLamports = solToLamports(p.maxExposureSol);
  const minUpBps = Math.round(p.minPriceUp * 10000);
  const maxUpBps = Math.round(p.maxPriceUp * 10000);
  const nearHighBps = Math.round(p.nearHigh * 10000);
  const tpBps = Math.round(p.takeProfit * 10000);
  const slBps = Math.round(p.stopLoss * 10000);
  const trailBps = Math.round(p.trail * 10000);
  const armBps = Math.round(p.trailArm * 10000);

  let peakEquity: bigint | null = null;
  let coinsTraded = 0;
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;

  function valueOf(state: BotState, mint: Pubkey, tokens: bigint): bigint {
    const curve = state.curves.get(mint);
    if (curve === undefined) return -txFeeOf(state);
    return positionValue(tokens, curve.virtual_quote_reserves, curve.virtual_token_reserves, txFeeOf(state));
  }

  function equityOf(state: BotState): bigint {
    let equity = state.cash;
    for (const [mint, holding] of state.positions) {
      const value = valueOf(state, mint, holding.token_amount);
      if (value > 0n) equity += value;
    }
    return equity;
  }

  function heldMainCount(state: BotState): number {
    let n = 0;
    for (const mint of state.positions.keys()) {
      if (!trackOf(mint).isProbe) n++;
    }
    return n;
  }

  function pendingMainBuys(state: BotState): number {
    let n = 0;
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'buy' && !trackOf(pending.order.mint).isProbe) n++;
    }
    return n;
  }

  function heldProbeCount(state: BotState): number {
    let n = 0;
    for (const mint of state.positions.keys()) {
      if (trackOf(mint).isProbe) n++;
    }
    return n;
  }

  function pendingProbeBuys(state: BotState): number {
    let n = 0;
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'buy' && trackOf(pending.order.mint).isProbe) n++;
    }
    return n;
  }

  function mainExposure(state: BotState): bigint {
    let total = 0n;
    for (const [mint, holding] of state.positions) {
      if (!trackOf(mint).isProbe) total += holding.cost_lamports;
    }
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'buy' && !trackOf(pending.order.mint).isProbe) {
        total += BigInt(pending.order.quote_lamports);
      }
    }
    return total;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const slot = batch.slot;
      const txFee = txFeeOf(state);

      // --- 1. fold fills back into per-mint state -------------------------
      for (const fill of batch.fills) {
        const t = trackOf(fill.mint);
        if (fill.side === 'buy') {
          t.pendingBuy = false;
          if (fill.status === 'filled') {
            t.entries += 1;
            if (!t.everBought) {
              t.everBought = true;
              coinsTraded += 1;
            }
            t.entrySlot = fill.slot;
            t.peakValue = 0n;
            t.armed = false;
          }
        } else {
          t.pendingSell = false;
          if (fill.status === 'filled') {
            t.lastExitSlot = fill.slot;
            t.entrySlot = -1;
            t.peakValue = 0n;
            t.armed = false;
            t.isProbe = false;
          }
        }
      }

      // --- 2. fold events: block time, creates, trade windows ------------
      const traded = new Set<Pubkey>();
      for (const event of batch.events) {
        if (event.block_time !== null && event.block_time !== undefined) {
          if (firstBlockTime === null) firstBlockTime = event.block_time;
          lastBlockTime = event.block_time;
        }
        const t = trackOf(event.mint);
        if (event.event === 'CreateEvent') {
          if (t.createdSlot === null) t.createdSlot = event.slot;
        } else if (event.event === 'TradeEvent') {
          traded.add(event.mint);
          t.hist.push({
            slot: event.slot,
            buy: event.is_buy,
            sol: BigInt(event.sol_amount),
            user: event.user,
            vq: BigInt(event.virtual_quote_reserves),
            vt: BigInt(event.virtual_token_reserves),
          });
          // Keep the window plus a slack tail for the pre-window anchor.
          const cutoff = slot - p.window - 2400;
          while (t.hist.length > 0 && t.hist[0]!.slot <= cutoff) t.hist.shift();
        } else {
          t.complete = true;
        }
      }

      // --- 3. equity, peak, drawdown brake -------------------------------
      const equity = equityOf(state);
      if (peakEquity === null || equity > peakEquity) peakEquity = equity;
      const drawdown = peakEquity > 0n ? Number(peakEquity - equity) / Number(peakEquity) : 0;
      const braked = drawdown > p.maxDrawdown;

      // --- 4. exits: sell the whole position ------------------------------
      let plannedMainBuys = 0;
      let plannedProbeBuys = 0;
      let plannedSpend = 0n;
      for (const [mint, holding] of state.positions) {
        const t = trackOf(mint);
        if (t.pendingSell) continue;
        if (t.isProbe) {
          // Probes are one-batch round trips: sell as soon as held.
          orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: p.buySlipBps });
          t.pendingSell = true;
          continue;
        }
        const value = valueOf(state, mint, holding.token_amount);
        const cost = holding.cost_lamports;
        if (cost <= 0n) continue;
        let exit = false;
        if (value * BPS >= cost * BigInt(BPS + BigInt(tpBps))) exit = true; // take profit
        else if (value * BPS <= cost * BigInt(BPS - BigInt(slBps))) exit = true; // stop loss
        else if (slot - t.entrySlot >= p.maxHold) exit = true; // time limit
        else {
          if (!t.armed && value * BPS >= cost * BigInt(BPS + BigInt(armBps))) t.armed = true;
          if (t.armed) {
            if (value > t.peakValue) t.peakValue = value;
            if (value * BPS <= t.peakValue * BigInt(BPS - BigInt(trailBps))) exit = true; // trailing stop
          }
        }
        if (exit) {
          orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: p.buySlipBps });
          t.pendingSell = true;
        }
      }

      // --- 5. main entries -------------------------------------------------
      const freeCash = () => state.freeCashLamports() - plannedSpend;
      for (const mint of traded) {
        const t = trackOf(mint);
        if (t.complete || t.pendingBuy || t.entries >= p.maxEntries) continue;
        if (state.positions.has(mint)) continue;
        if (t.lastExitSlot >= 0 && slot - t.lastExitSlot < p.cooldown) continue;
        if (t.createdSlot === null || slot - t.createdSlot < p.minAge) continue;
        if (braked) break;
        if (heldMainCount(state) + pendingMainBuys(state) + plannedMainBuys >= p.maxMain) break;
        if (state.committedPositionCount() + plannedMainBuys + plannedProbeBuys >= state.hello.caps.max_open_positions) break;

        const curve = state.curves.get(mint);
        if (curve === undefined) continue;
        const rq = curve.real_quote_reserves;
        if (rq < minRqLamports || rq > maxRqLamports) continue;

        // Window stats over the last `window` slots.
        const from = slot - p.window;
        let buys = 0;
        let net = 0n;
        const buyers = new Set<Pubkey>();
        let anchor: TradeRec | null = null;
        let highN = 0n;
        let highD = 1n;
        let lastN = 0n;
        let lastD = 1n;
        for (const trade of t.hist) {
          if (trade.slot <= from) {
            anchor = trade;
            continue;
          }
          if (trade.buy) {
            buys += 1;
            buyers.add(trade.user);
            net += trade.sol;
          } else {
            net -= trade.sol;
          }
          if (highN === 0n || !ratioGte(highN, highD, trade.vq, trade.vt)) {
            highN = trade.vq;
            highD = trade.vt;
          }
          lastN = trade.vq;
          lastD = trade.vt;
        }
        if (buys < p.minBuys || buyers.size < p.minBuyers) continue;
        if (net < minNetLamports) continue;
        const start = anchor ?? t.hist.find((trade) => trade.slot > from);
        if (start === undefined || lastN === 0n) continue;
        if (!upAtLeast(lastN, lastD, start.vq, start.vt, minUpBps)) continue;
        if (!upAtMost(lastN, lastD, start.vq, start.vt, maxUpBps)) continue;
        if (!atLeastFracOf(lastN, lastD, highN, highD, nearHighBps)) continue;

        // Size: fixed stake, capped at 1% of real reserves, at least minBuy.
        let size = stakeLamports;
        const cap = state.maxBuyLamports(mint);
        if (cap > 0n && size > cap) size = cap;
        if (size < minBuyLamports) continue;
        if (freeCash() < size + txFee) continue;
        if (mainExposure(state) + plannedSpend + size > maxExposureLamports) continue;

        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: p.buySlipBps });
        t.pendingBuy = true;
        t.isProbe = false;
        plannedMainBuys += 1;
        plannedSpend += size + txFee;
      }

      // --- 6. guardrail probes ---------------------------------------------
      const paceDone =
        firstBlockTime !== null &&
        lastBlockTime !== null &&
        lastBlockTime - firstBlockTime > p.paceSecs / 2;
      if (paceDone && coinsTraded < p.targetCoins) {
        for (const mint of traded) {
          if (heldProbeCount(state) + pendingProbeBuys(state) + plannedProbeBuys >= p.maxProbes) break;
          if (state.committedPositionCount() + plannedMainBuys + plannedProbeBuys >= state.hello.caps.max_open_positions) break;
          const t = trackOf(mint);
          if (t.complete || t.pendingBuy || t.everBought || t.probed) continue;
          if (state.positions.has(mint)) continue;
          if (t.createdSlot === null || slot - t.createdSlot < p.minAge) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined) continue;
          const rq = curve.real_quote_reserves;
          if (rq < minRqLamports || rq > maxRqLamports) continue;
          const cap = state.maxBuyLamports(mint);
          if (cap < probeLamports) continue;
          if (freeCash() < probeLamports + txFee) continue;
          orders.push({ side: 'buy', mint, quote_lamports: probeLamports, max_slippage_bps: p.buySlipBps });
          t.pendingBuy = true;
          t.isProbe = true;
          t.probed = true;
          plannedProbeBuys += 1;
          plannedSpend += probeLamports + txFee;
        }
      }

      return orders;
    },
  };
}
