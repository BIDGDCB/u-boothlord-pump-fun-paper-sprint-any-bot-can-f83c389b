# Pump.fun Paper Sprint: Any Bot Can Win

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/BIDGDCB/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/BIDGDCB/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
make.fun entry for `u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b`.

A paper-trading bot for the 6-hour pump.fun replay. Highest net PnL wins.

## Strategy

Momentum entries with fast rotation:

- **Entry:** a coin qualifies when its recent tape (last 20 trades) shows at
  least 4 buys from at least 3 distinct buyers, net SOL flowing in (≥ 0.4),
  price up 3–150% over the window, holding near its window high, with inflow
  accelerating into the newer half. Coins younger than 8 slots are skipped.
- **Size:** 0.05 SOL per position, at most 5 open, never more than the
  1%-of-real-reserve size cap.
- **Exits:** stop loss at 85% of cost, take profit at 160%, a trailing stop
  (arms at 125% of cost, exits at 80% of peak), and a hard 3600-slot time
  limit.
- **Probes:** when a slot is free and no coin earns a momentum entry, a small
  0.02 SOL probe on the freshest liquid curve with non-negative recent flow,
  exited within 900 slots — so the run keeps cycling coins toward the
  20-coin round-trip guardrail.

Fully deterministic: no clock, no randomness, no environment reads.

## Layout

- `main.ts` — the strategy (Node 22, standard library only besides the shim).
- `vendor/makefun-bot.ts` — the kit's `sdk/ts/makefun-bot.ts`, copied byte
  for byte as its header instructs.

## Test locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot .
```
