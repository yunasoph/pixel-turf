// packages/shared/src/engine.ts
import { GameConfig, GameState, Player, TickResult, GameEvent, PowerUpType } from './protocol';
import { mulberry32 } from './prng';
import { botThink } from './bots';
import { MAX_PLAYERS, SPRINT_S, SPRINT_CD_S, TURBO_S, SHIELD_S, BOMB_RADIUS, PU_MAX, PU_MIN_PLAYER_DIST } from './constants';

export function createGame(config: GameConfig): GameState {
  const rand = mulberry32(config.seed);
  const size = config.size;
  const cells = new Int8Array(size * size).fill(-1);
  
  // Shuffled spawns
  const spawns = [
    [6, 6], [size - 7, 6], [6, size - 7], [size - 7, size - 7],
    [Math.floor(size / 2), 4], [4, Math.floor(size / 2)]
  ];
  for (let i = spawns.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [spawns[i], spawns[j]] = [spawns[j], spawns[i]];
  }

  const players: Player[] = config.slots.slice(0, MAX_PLAYERS).map((slot, i) => {
    const [sx, sy] = spawns[i];
    const dx = sx < size / 2 ? 1 : -1;
    const p: Player = {
      i, name: slot.name, bot: slot.kind === 'bot', lv: slot.botLevel,
      x: sx, y: sy, px: sx, py: sy, dx, dy: 0, q: [],
      score: 0, streak: 0, spr: 0, sprMax: SPRINT_S, cd: 0, shield: 0
    };
    // Claim 3x3 start block
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const k = (sy + b) * size + (sx + a);
        cells[k] = i;
        p.score++;
      }
    }
    return p;
  });

  return {
    config, size, cells, players, pu: [],
    puT: 3, // First spawn ~3s after GO
    puNextId: 0,
    rand, ticks: 0
  };
}

export function queueInput(state: GameState, pIdx: number, dx: number, dy: number): void {
  const p = state.players[pIdx];
  if (!p || p.bot) return;
  if (p.q.length >= 2) return;
  
  const ref = p.q.length > 0 ? p.q[p.q.length - 1] : { dx: p.dx, dy: p.dy };
  if (ref.dx === dx && ref.dy === dy) return; // Ignore duplicate
  
  p.q.push({ dx, dy });
}

export function requestSprint(state: GameState, pIdx: number): boolean {
  const p = state.players[pIdx];
  if (!p || !state.config.sprint) return false;
  if (p.spr <= 0 && p.cd <= 0) {
    p.spr = p.sprMax;
    return true;
  }
  return false;
}

function claim(state: GameState, p: Player, x: number, y: number, quiet: boolean, events: GameEvent[]): boolean {
  const k = y * state.size + x;
  const o = state.cells[k];
  if (o === p.i) return false;
  
  if (o >= 0 && state.players[o].shield > 0) {
    if (!quiet) events.push({ type: 'blocked', k, attacker: p.i, defender: o });
    return false;
  }
  
  const prevOwner = o;
  state.cells[k] = p.i;
  p.score++;
  
  if (prevOwner >= 0) {
    state.players[prevOwner].score--;
    p.streak++;
    if (!quiet) {
      events.push({ type: 'claim', k, owner: p.i, prevOwner, quiet });
      if (p.streak > 0 && p.streak % 5 === 0) {
        events.push({ type: 'streak', pIdx: p.i, streak: p.streak });
      }
    }
  } else {
    p.streak = 0;
    if (!quiet) events.push({ type: 'claim', k, owner: p.i, prevOwner, quiet });
  }
  return true;
}

function spawnPU(state: GameState, events: GameEvent[]) {
  if (state.pu.length >= PU_MAX || !state.config.powerups) return;
  
  for (let n = 0; n < 30; n++) {
    const x = 2 + Math.floor(state.rand() * (state.size - 4));
    const y = 2 + Math.floor(state.rand() * (state.size - 4));
    const k = y * state.size + x;
    
    if (state.pu.some(u => u.k === k)) continue;
    if (state.players.some(p => Math.abs(p.x - x) + Math.abs(p.y - y) < PU_MIN_PLAYER_DIST)) continue;
    
    const types: PowerUpType[] = ['bomb', 'turbo', 'shield'];
    const type = types[Math.floor(state.rand() * 3)];
    state.pu.push({ id: state.puNextId++, k, type });
    events.push({ type: 'puSpawn', k, puType: type });
    return;
  }
}

function grab(state: GameState, p: Player, events: GameEvent[]) {
  const k = p.y * state.size + p.x;
  const idx = state.pu.findIndex(u => u.k === k);
  if (idx < 0) return;
  
  const u = state.pu.splice(idx, 1)[0];
  events.push({ type: 'grab', pIdx: p.i, puType: u.type });
  
  if (u.type === 'bomb') {
    for (let a = -BOMB_RADIUS; a <= BOMB_RADIUS; a++) {
      for (let b = -BOMB_RADIUS; b <= BOMB_RADIUS; b++) {
        const nx = p.x + a, ny = p.y + b;
        if (nx >= 0 && ny >= 0 && nx < state.size && ny < state.size) {
          claim(state, p, nx, ny, true, events);
        }
      }
    }
    events.push({ type: 'bomb', pIdx: p.i, cx: p.x, cy: p.y });
  } else if (u.type === 'turbo') {
    p.spr = p.sprMax = TURBO_S;
  } else if (u.type === 'shield') {
    p.shield = SHIELD_S;
  }
}

export function step(state: GameState): TickResult {
  const events: GameEvent[] = [];
  const ds = 1 / 12; // TICK duration in seconds
  state.ticks++;
  
  // 1. Power-up spawn timer
  state.puT -= ds;
  if (state.puT <= 0) {
    spawnPU(state, events);
    state.puT = 5 + state.rand() * 3;
  }
  
  // 2. Shuffle player processing order
  const ord = [...state.players];
  for (let i = ord.length - 1; i > 0; i--) {
    const j = Math.floor(state.rand() * (i + 1));
    [ord[i], ord[j]] = [ord[j], ord[i]];
  }
  
  for (const p of ord) {
    // Decrement timers
    if (p.shield > 0) p.shield = Math.max(0, p.shield - ds);
    
    if (p.spr > 0) {
      p.spr -= ds;
      if (p.spr <= 0) {
        p.spr = 0;
        p.cd = SPRINT_CD_S;
        events.push({ type: 'sprintEnd', pIdx: p.i });
      }
    } else if (p.cd > 0) {
      p.cd -= ds;
    }
    
    // Bot / Human input
    if (p.bot) {
      if (state.config.sprint && p.spr <= 0 && p.cd <= 0 && state.rand() < 0.03) {
        p.spr = p.sprMax;
        events.push({ type: 'sprintStart', pIdx: p.i });
      }
      const dir = botThink(state, p);
      if (dir) { p.dx = dir.dx; p.dy = dir.dy; }
    } else if (p.q.length > 0) {
      const next = p.q.shift()!;
      p.dx = next.dx;
      p.dy = next.dy;
    }
    
    // Save previous
    p.px = p.x;
    p.py = p.y;
    
    // Move 1 or 2 steps
    const steps = p.spr > 0 ? 2 : 1;
    for (let s = 0; s < steps; s++) {
      const nx = p.x + p.dx, ny = p.y + p.dy;
      if (nx < 0 || ny < 0 || nx >= state.size || ny >= state.size) break;
      
      p.x = nx;
      p.y = ny;
      claim(state, p, nx, ny, false, events);
      grab(state, p, events);
    }
  }
  
  // 3. Settle
  for (const p of ord) {
    const alone = !state.players.some(q => q !== p && q.x === p.x && q.y === p.y);
    if (alone) {
      claim(state, p, p.x, p.y, true, events);
    }
  }
  
  return { events };
}

export function scores(state: GameState): number[] {
  return state.players.map(p => p.score);
}

export function isOver(state: GameState): boolean {
  // Ticks = seconds * 12
  return state.ticks >= state.config.durationS * 12;
}
