import { describe, it, expect } from 'vitest';
import { createGame, step, scores, requestSprint, isOver } from '../src/engine';
import { GameConfig } from '../src/protocol';

const makeConfig = (seed = 12345): GameConfig => ({
  size: 40, durationS: 90, sprint: true, powerups: true, seed,
  slots: [
    { kind: 'human', name: 'P1', skinId: 'default', colorId: 0 },
    { kind: 'bot', name: 'Bot1', skinId: 'default', colorId: 1, botLevel: 'normal' },
    { kind: 'bot', name: 'Bot2', skinId: 'default', colorId: 2, botLevel: 'normal' },
    { kind: 'bot', name: 'Bot3', skinId: 'default', colorId: 3, botLevel: 'normal' },
  ]
});

describe('Shared Engine', () => {
  it('should initialize players with 3x3 blocks', () => {
    const state = createGame(makeConfig());
    expect(state.players[0].score).toBe(9);
    expect(state.cells[0]).toBe(-1); // Unowned
  });

  it('should be strictly deterministic', () => {
    const s1 = createGame(makeConfig(999));
    const s2 = createGame(makeConfig(999));
    
    for (let i = 0; i < 100; i++) {
      step(s1);
      step(s2);
    }
    expect(Array.from(s1.cells)).toEqual(Array.from(s2.cells));
    expect(scores(s1)).toEqual(scores(s2));
  });

  it('should enforce shield rules', () => {
    const state = createGame(makeConfig());
    const p0 = state.players[0];
    const p1 = state.players[1];
    
    // Give P1 a shield
    p1.shield = 5;
    const k = p1.y * state.size + p1.x; // P1's tile
    
    // P0 steps on P1's tile
    p0.x = p1.x; p0.y = p1.y;
    
    // Manually trigger settle/claim logic via a step
    const { events } = step(state);
    const blocked = events.find(e => e.type === 'blocked');
    
    expect(blocked).toBeDefined();
    expect(state.cells[k]).toBe(p1.i); // P1 still owns it
  });

  it('should finish a 90s game in under 1 second', () => {
    const start = performance.now();
    const state = createGame(makeConfig());
    
    while (!isOver(state)) {
      step(state);
    }
    
    const duration = performance.now() - start;
    console.log(`90s game simulated in ${duration.toFixed(2)}ms`);
    expect(duration).toBeLessThan(1000);
    expect(state.ticks).toBe(90 * 12);
  });
});
