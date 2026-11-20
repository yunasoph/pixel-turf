// packages/shared/src/bots.ts
import { GameState, Player } from './protocol';

const LV = {
  easy:   { look: 2, noise: 3.2, pu: 0.3, spr: 0.006, str: 0.7, idle: 0.3 },
  normal: { look: 4, noise: 1.5, pu: 1.2, spr: 0.03,  str: 0.9, idle: 0   },
  hard:   { look: 4, noise: 1.0, pu: 1.6, spr: 0.09,  str: 0.9, idle: 0   },
};

export function botThink(state: GameState, p: Player): { dx: number, dy: number } | null {
  const L = LV[p.lv || 'normal'];
  const nx = p.x + p.dx, ny = p.y + p.dy;
  
  if (L.idle && state.rand() < L.idle && nx >= 0 && ny >= 0 && nx < state.size && ny < state.size) {
    return null; // Keep current heading
  }

  const dirs = [
    { dx: p.dx, dy: p.dy },             // Straight
    { dx: p.dy, dy: -p.dx },            // Left
    { dx: -p.dy, dy: p.dx }             // Right
  ];

  let best: { dx: number, dy: number } | null = null;
  let bs = -1e9;
  
  // Find nearest powerup
  let tgtK = -1, td = 99;
  for (const u of state.pu) {
    const ux = u.k % state.size, uy = Math.floor(u.k / state.size);
    const d = Math.abs(ux - p.x) + Math.abs(uy - p.y);
    if (d < td) { td = d; tgtK = u.k; }
  }

  for (const dir of dirs) {
    let s = state.rand() * L.noise;
    let x = p.x, y = p.y, ok = true;
    
    for (let l = 1; l <= L.look; l++) {
      x += dir.dx; y += dir.dy;
      if (x < 0 || y < 0 || x >= state.size || y >= state.size) {
        if (l === 1) ok = false;
        s -= 3; break;
      }
      const o = state.cells[y * state.size + x];
      s += (o === -1 ? 2 : o === p.i ? -0.4 : 3) / l;
    }

    if (tgtK >= 0 && ok) {
      const ux = tgtK % state.size, uy = Math.floor(tgtK / state.size);
      const distAfter = Math.abs(ux - (p.x + dir.dx)) + Math.abs(uy - (p.y + dir.dy));
      s += (td - distAfter) * L.pu;
    }

    if (ok && dir.dx === p.dx && dir.dy === p.dy && state.rand() < L.str) s += 0.8;
    
    if (ok && s > bs) {
      bs = s;
      best = dir;
    }
  }
  return best;
}
