// Pump.fun Paper Sprint bot — momentum entries with fast rotation.
//
// Idea: most new pump.fun coins fade, but a few run hard in their first minutes.
// This bot buys only coins whose recent tape shows real buying (several distinct
// buyers, net SOL flowing in, price rising and holding near its window high),
// sizes each position small (0.05 SOL), and exits fast: a stop loss, a take
// profit, a trailing stop once a position is up, and a hard time limit. When
// no coin earns a momentum entry and a position slot is free, it takes a small
// 0.02 SOL probe on the freshest liquid curve so the run keeps cycling through
// coins — the guardrails need round trips on at least 20 coins, and a bot that
// waits for perfect setups can starve.
//
// Deterministic by construction: no clock, no randomness, no environment reads;
// iteration only over insertion-ordered maps fed by the batch stream, and any
// tie is broken by first-seen order.
//
// The SDK shim (vendor/makefun-bot.ts) is the kit's sdk/ts/makefun-bot.ts,
// copied byte for byte as its header instructs; the strategy below is my own.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;
const STAKE = SOL / 20n; // 0.05 SOL per momentum position
const PROBE_STAKE = SOL / 50n; // 0.02 SOL per probe position
const MIN_BUY = SOL / 200n; // 0.005 SOL: smallest buy worth sending
const BUY_SLIP_BPS = 500;
const SELL_SLIP_BPS = 10_000;

const MIN_AGE_SLOTS = 8; // ignore curves younger than this: mostly bundled launches
const TAPE_LEN = 20; // trades in the entry window
const MIN_BUYS = 4; // buy trades in the window
const MIN_BUYERS = 3; // distinct buying wallets in the window
const MIN_NET_SOL = 0.4; // net SOL flowing in over the window
const MIN_PRICE_UP = 0.03; // price rise over the window, at least 3%
const MAX_PRICE_UP = 1.5; // skip curves that already ran too far in one window
const NEAR_HIGH = 0.95; // price now at least 95% of the window high
const STOP_LOSS = 0.85; // sell when value falls to 85% of cost
const TAKE_PROFIT = 1.6; // sell when value reaches 160% of cost
const TRAIL_ARM = 1.25; // trailing stop arms once value hits 125% of cost
const TRAIL = 0.8; // then sell if value falls to 80% of its peak
const MAX_HOLD_SLOTS = 3600; // hard time exit for momentum positions (~24 min)
const PROBE_HOLD_SLOTS = 900; // probes exit much sooner
const MAX_DECISIONS = 60; // most coins the bot ever decides on in one run

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CurveTape {
  createdSlot: number;
  trades: TapeTrade[];
  firstPrice: number;
}

interface OpenTrade {
  cost: bigint;
  entrySlot: number;
  peak: number; // best value in lamports seen so far
  probe: boolean;
}

const tapes = new Map<Pubkey, CurveTape>();
const decided = new Set<Pubkey>();
const open = new Map<Pubkey, OpenTrade>();
// Mints bought as probes (short time exit). The entry sync in onBatch reads
// this set, so a position whose mint is in it counts as a probe. Declared
// before runBot: the closure reads it while the replay runs.
const probeMints = new Set<Pubkey>();

function priceOf(curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): number {
  const vt = Number(curve.virtual_token_reserves);
  if (vt <= 0) return 0;
  return Number(curve.virtual_quote_reserves) / vt;
}

function valueLamports(tokens: bigint, price: number): number {
  return Number(tokens) * price;
}

function tapeStats(tape: CurveTape): {
  buys: number;
  buyers: number;
  netSol: number;
  priceUp: number;
  nearHigh: boolean;
  accel: boolean;
} {
  const window = tape.trades.slice(-TAPE_LEN);
  let buys = 0;
  let netSol = 0;
  const buyers = new Set<string>();
  let high = 0;
  for (const t of window) {
    if (t.buy) {
      buys += 1;
      buyers.add(t.user);
      netSol += t.sol;
    } else {
      netSol -= t.sol;
    }
    if (t.price > high) high = t.price;
  }
  const first = window[0]?.price ?? 0;
  const last = window[window.length - 1]?.price ?? 0;
  const priceUp = first > 0 ? last / first - 1 : 0;
  const half = Math.floor(window.length / 2);
  let netFirst = 0;
  let netSecond = 0;
  window.forEach((t, i) => {
    const d = t.buy ? t.sol : -t.sol;
    if (i < half) netFirst += d;
    else netSecond += d;
  });
  return {
    buys,
    buyers: buyers.size,
    netSol,
    priceUp,
    nearHigh: high > 0 && last >= NEAR_HIGH * high,
    accel: netFirst <= 0 || netSecond >= netFirst,
  };
}

function momentumSignal(tape: CurveTape, slot: number): boolean {
  if (slot - tape.createdSlot < MIN_AGE_SLOTS) return false;
  if (tape.trades.length < 6) return false;
  const s = tapeStats(tape);
  return (
    s.buys >= MIN_BUYS &&
    s.buyers >= MIN_BUYERS &&
    s.netSol >= MIN_NET_SOL &&
    s.priceUp >= MIN_PRICE_UP &&
    s.priceUp <= MAX_PRICE_UP &&
    s.nearHigh &&
    s.accel
  );
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    // 1. Fold this batch's events into the tapes.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const curve = state.curves.get(e.mint);
        tapes.set(e.mint, {
          createdSlot: e.slot,
          trades: [],
          firstPrice: curve ? priceOf(curve) : 0,
        });
      } else if (e.event === 'TradeEvent') {
        const tape = tapes.get(e.mint);
        if (tape === undefined) continue;
        tape.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(BigInt(e.sol_amount)) / 1e9,
          user: e.user,
          price: priceOf({
            virtual_quote_reserves: BigInt(e.virtual_quote_reserves),
            virtual_token_reserves: BigInt(e.virtual_token_reserves),
          }),
        });
        if (tape.trades.length > 40) tape.trades.splice(0, tape.trades.length - 40);
      } else {
        // CompleteEvent: the harness closes the position; drop the tape.
        tapes.delete(e.mint);
      }
    }

    // 2. Sync open positions with the account: record entries, drop closed ones.
    for (const mint of [...open.keys()]) {
      if (!state.positions.has(mint)) open.delete(mint);
    }
    for (const [mint, holding] of state.positions) {
      if (!open.has(mint)) {
        const curve = state.curves.get(mint);
        const value = curve ? valueLamports(holding.token_amount, priceOf(curve)) : 0;
        open.set(mint, { cost: holding.cost_lamports, entrySlot: state.slot, peak: value, probe: probeMints.has(mint) });
      }
    }

    const orders: OrderInput[] = [];
    const caps = state.hello.caps;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    const pendingSell = new Set<Pubkey>();
    for (const p of state.pending.values()) if (p.order.side === 'sell') pendingSell.add(p.order.mint);

    // 3. Exits first: stop loss, take profit, trailing stop, time limit.
    for (const [mint, holding] of state.positions) {
      if (pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const trade = open.get(mint);
      if (trade === undefined) continue;
      const value = valueLamports(holding.token_amount, priceOf(curve));
      if (value > trade.peak) trade.peak = value;
      const cost = Number(trade.cost);
      const ratio = cost > 0 ? value / cost : 0;
      const held = state.slot - trade.entrySlot;
      const maxHold = trade.probe ? PROBE_HOLD_SLOTS : MAX_HOLD_SLOTS;
      const trailing = trade.peak >= TRAIL_ARM * cost && value <= TRAIL * trade.peak;
      if (ratio <= STOP_LOSS || ratio >= TAKE_PROFIT || trailing || held >= maxHold) {
        if (orders.length >= caps.max_orders_per_batch) break;
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIP_BPS });
      }
    }

    // 4. Entries: momentum buys on this batch's coins, first-seen order.
    for (const e of batch.events) {
      if (slots <= 0 || orders.length >= caps.max_orders_per_batch) break;
      if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
      const mint = e.mint;
      if (decided.has(mint) || state.positions.has(mint)) continue;
      const tape = tapes.get(mint);
      const curve = state.curves.get(mint);
      if (tape === undefined || curve === undefined || curve.complete) continue;
      if (!momentumSignal(tape, state.slot)) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY) continue;
      const amount = cap < STAKE ? cap : STAKE;
      if (free < amount + tx) continue;
      decided.add(mint);
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIP_BPS });
      free -= amount + tx;
      slots -= 1;
    }

    // 5. Probe: when a slot is free and nothing earned a momentum entry, take
    // the freshest liquid curve with non-negative recent flow so the run keeps
    // cycling coins toward the 20-coin guardrail.
    if (slots > 0 && orders.length < caps.max_orders_per_batch && decided.size < MAX_DECISIONS) {
      let best: Pubkey | null = null;
      let bestTrades = 0;
      for (const [mint, tape] of tapes) {
        if (decided.has(mint) || state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (tape.trades.length < 5) continue;
        const s = tapeStats(tape);
        if (s.netSol < 0) continue;
        if (tape.trades.length > bestTrades) {
          best = mint;
          bestTrades = tape.trades.length;
        }
      }
      if (best !== null) {
        const curve = state.curves.get(best);
        const cap = curve ? state.maxBuyLamports(best) : 0n;
        if (cap >= MIN_BUY) {
          const amount = cap < PROBE_STAKE ? cap : PROBE_STAKE;
          if (free >= amount + tx) {
            decided.add(best);
            orders.push({ side: 'buy', mint: best, quote_lamports: amount, max_slippage_bps: BUY_SLIP_BPS });
            free -= amount + tx;
            slots -= 1;
            // Mark the probe so its time exit is the short one (the entry
            // sync in step 2 picks the flag up from probeMints next batch).
            probeMints.add(best);
          }
        }
      }
    }
    return orders;
  },
});
