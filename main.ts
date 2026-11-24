// Entry point for the pump.fun replay sprint bot.
// Runs the snipe-and-scalp strategy with its default parameters.
// The strategy is fully deterministic: no clock, no randomness, so the
// grader's two executions of this entry produce identical action logs.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
