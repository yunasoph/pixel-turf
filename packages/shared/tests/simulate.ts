// packages/shared/tests/simulate.ts
// Headless full-game simulator: runs a complete match to completion and
// prints the final scoreboard + wall-clock simulation time.
//
// Usage: npm run simulate --workspace=packages/shared
import { createGame, step, scores, isOver } from '../src/engine';
import { GameConfig } from '../src/protocol';

const config: GameConfig = {
  size: 40,
  durationS: 90,
  sprint: true,
  powerups: true,
  seed: Date.now() % 1000000,
  slots: [
    { kind: 'human', name: 'You',  skinId: 'default', colorId: 0 },
    { kind: 'bot',   name: 'Bot A', skinId: 'default', colorId: 1, botLevel: 'easy' },
    { kind: 'bot',   name: 'Bot B', skinId: 'default', colorId: 2, botLevel: 'normal' },
    { kind: 'bot',   name: 'Bot C', skinId: 'default', colorId: 3, botLevel: 'hard' },
  ],
};

const state = createGame(config);
const start = performance.now();

let totalEvents = 0;
while (!isOver(state)) {
  const { events } = step(state);
  totalEvents += events.length;
}

const duration = performance.now() - start;

// Final scoreboard, sorted by score desc
const board = state.players
  .map((p) => ({ name: p.name, bot: p.bot, score: p.score }))
  .sort((a, b) => b.score - a.score);

console.log('=== Pixel Turf — Headless Simulation ===');
console.log(`Seed:        ${config.seed}`);
console.log(`Duration:    ${config.durationS}s (${state.ticks} ticks)`);
console.log(`Sim time:    ${duration.toFixed(2)}ms`);
console.log(`Total events: ${totalEvents}`);
console.log('\nFinal standings:');
board.forEach((r, i) => {
  console.log(`  ${i + 1}. ${r.name.padEnd(8)} ${r.bot ? '(bot)' : '(human)'.padStart(7)}  ${r.score} pts`);
});

const [winner] = board;
console.log(`\n🏆 Winner: ${winner.name} (${winner.score} pts)`);
