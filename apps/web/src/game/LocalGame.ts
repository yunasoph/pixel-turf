import * as THREE from "three";
import {
  COLORS,
  GameConfig,
  GameState,
  GameEvent,
  PowerUpType,
  Player,
  createGame,
  step,
  queueInput,
  requestSprint,
  isOver,
  TICK_MS,
  SPRINT_CD_S,
} from "@pixel-turf/shared";
import type { SnapshotPayload, TickPayload } from "@pixel-turf/shared";
import { useHudStore } from "./hudStore";

export interface LocalGameApi {
  steer(dx: number, dy: number): void;
  sprint(): void;
  toggleCamera(): void;
  toggleMute(): boolean;
}

const KEYMAP: Record<string, [number, number]> = {
  ArrowUp: [0, -1],
  w: [0, -1],
  ArrowDown: [0, 1],
  s: [0, 1],
  ArrowLeft: [-1, 0],
  a: [-1, 0],
  ArrowRight: [1, 0],
  d: [1, 0],
};

const PT: Record<PowerUpType, { col: string; icon: string; msg: string }> = {
  bomb: {
    col: "#ff8a3d",
    icon: "BOMB",
    msg: "BOMB! 5x5 area claimed",
  },
  turbo: {
    col: "#ffe14d",
    icon: "TURBO",
    msg: "TURBO! 4s of speed",
  },
  shield: {
    col: "#7df9ff",
    icon: "SHIELD",
    msg: "SHIELD! Your tiles are locked for 6s",
  },
};

interface PlayerViz {
  group: THREE.Group;
  inner: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  shield: THREE.Mesh;
  phase: number;
  swing: number;
}

interface PowerUpViz {
  group: THREE.Group;
  core: THREE.Mesh;
  ring: THREE.Mesh;
  coreGeo: THREE.BufferGeometry;
  age: number;
}

export class LocalGame implements LocalGameApi {
  private canvas: HTMLCanvasElement;
  private config: GameConfig;
  private engine: GameState;
  private size: number;
  public netMode = false;
  public netInput: {
    steer?: (dx: number, dy: number) => void;
    sprint?: () => void;
  } | null = null;

  private lastTickAt = 0;

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;

  private boxGeo = new THREE.BoxGeometry(1, 1, 1);
  private ringGeo = new THREE.RingGeometry(0.35, 0.5, 32);
  private circleGeo = new THREE.CircleGeometry(0.62, 24);
  private localRingGeo = new THREE.RingGeometry(0.62, 0.72, 32);
  private shieldGeo = new THREE.SphereGeometry(0.95, 18, 14);

  private tiles!: THREE.InstancedMesh;
  private dynamic = new THREE.Group();

  private target!: Int8Array;
  private prevOwner!: Int8Array;
  private fade!: Float32Array;
  private allTilesDirty = true;

  private playerColors: string[] = [];
  private playerColor3: THREE.Color[] = [];
  private playerBasicMaterials: THREE.MeshBasicMaterial[] = [];
  private playerViz: PlayerViz[] = [];

  private puViz = new Map<number, PowerUpViz>();

  private rings: { mesh: THREE.Mesh; t: number }[] = [];
  private particles: THREE.Mesh[] = [];

  private phase: "countdown" | "play" | "over" = "countdown";
  private countdownStart = performance.now();
  private playStart = 0;

  private last = performance.now();
  private acc = 0;
  private raf = 0;
  private disposed = false;

  private userFollow = true;
  private snap = true;
  private camPos = new THREE.Vector3(0, 40, 30);
  private camTar = new THREE.Vector3();
  private shake = 0;

  private tmpTarget = new THREE.Vector3();
  private dummy = new THREE.Object3D();
  private tmpColor = new THREE.Color();
  private emptyColor = new THREE.Color(0x1b2040);
  private shieldColor = new THREE.Color(0x7df9ff);

  private lastBlockedToast = 0;
  private lastHud = 0;
  private lastCountdownText = "";
  private lastMM = 0;

  private lastShields: boolean[] = [];

  private audio: AudioContext | null = null;
  private muted = false;

  private mmCtx: CanvasRenderingContext2D | null = null;
  private resizeObserver!: ResizeObserver;

  private touchStart: [number, number] | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    minimap: HTMLCanvasElement | null,
    config: GameConfig
  ) {
    this.canvas = canvas;
    this.config = config;
    this.engine = createGame(config);
    this.size = config.size;

    this.playerColors = config.slots.map(
      (slot) => COLORS[slot.colorId % COLORS.length]
    );
    this.playerColor3 = this.playerColors.map(
      (c) => new THREE.Color(c).multiplyScalar(0.92)
    );
    this.playerBasicMaterials = this.playerColors.map(
      (c) => new THREE.MeshBasicMaterial({ color: c })
    );

    this.mmCtx = minimap?.getContext("2d") ?? null;

    this.initAudio();
    this.initThree();
    this.initTiles();
    this.initPlayers();
    this.initListeners();

    this.lastShields = this.engine.players.map(() => false);
  }

  /* ---------------- public API ---------------- */

  start() {
    this.audio?.resume().catch(() => {});
    useHudStore.getState().reset(this.config.durationS);
    this.updateHud(performance.now());
    this.raf = requestAnimationFrame(this.loop);
  }

  steer(dx: number, dy: number) {
    if (this.netMode) {
      this.netInput?.steer?.(dx, dy);
      return;
    }

    if (this.phase !== "play") return;

    queueInput(this.engine, 0, dx, dy);
  }

  sprint() {
    if (this.netMode) {
      this.netInput?.sprint?.();
      return;
    }

    if (this.phase !== "play") return;

    const ok = requestSprint(this.engine, 0);
    if (ok) this.blip(560, 0.12, "triangle", 0.06);
  }

  toggleCamera() {
    this.userFollow = !this.userFollow;
  }

  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);

    window.removeEventListener("keydown", this.onKeyDown);

    const touchEl = this.canvas.parentElement ?? this.canvas;
    touchEl.removeEventListener("touchstart", this.onTouchStart);
    touchEl.removeEventListener("touchmove", this.onTouchMove);

    this.resizeObserver.disconnect();
    this.renderer.dispose();
  }

  /* ---------------- init ---------------- */

  private initAudio() {
    try {
      const Ctx =
        window.AudioContext ||
        (window as any).webkitAudioContext;
      this.audio = new Ctx();
    } catch {
      this.audio = null;
    }
  }

  private initThree() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
    });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0e1a);
    this.scene.fog = new THREE.Fog(0x0b0e1a, 35, 100);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);

    const hemi = new THREE.HemisphereLight(0xdde4ff, 0x232846, 1.0);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(-14, 26, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);

    const bound = Math.max(28, this.size * 0.7);
    sun.shadow.camera.left = -bound;
    sun.shadow.camera.right = bound;
    sun.shadow.camera.top = bound;
    sun.shadow.camera.bottom = -bound;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 80;

    this.scene.add(sun);

    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(this.size + 1.4, 0.4, this.size + 1.4),
      new THREE.MeshStandardMaterial({
        color: 0x151a35,
        roughness: 0.9,
      })
    );
    slab.position.y = -0.22;
    slab.receiveShadow = true;
    this.scene.add(slab);

    this.scene.add(this.dynamic);
  }

  private initTiles() {
    const count = this.size * this.size;

    this.tiles = new THREE.InstancedMesh(
      this.boxGeo,
      new THREE.MeshStandardMaterial({
        roughness: 0.55,
      }),
      count
    );
    this.tiles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tiles.receiveShadow = true;
    this.scene.add(this.tiles);

    this.target = new Int8Array(this.engine.cells);
    this.prevOwner = new Int8Array(this.engine.cells);
    this.fade = new Float32Array(count).fill(1);

    for (let k = 0; k < count; k++) {
      this.setTile(k, 1);
    }

    this.tiles.instanceMatrix.needsUpdate = true;
    if (this.tiles.instanceColor) {
      this.tiles.instanceColor.needsUpdate = true;
    }
  }

  private initPlayers() {
    this.playerViz = this.engine.players.map((p) =>
      this.makeChar(p, this.playerColors[p.i])
    );
  }

  private initListeners() {
    window.addEventListener("keydown", this.onKeyDown);

    const touchEl = this.canvas.parentElement ?? this.canvas;
    touchEl.addEventListener("touchstart", this.onTouchStart, {
      passive: true,
    });
    touchEl.addEventListener("touchmove", this.onTouchMove, {
      passive: true,
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
    this.resize();
  }

  /* ---------------- listeners ---------------- */

  private onKeyDown = (e: KeyboardEvent) => {
    const key = e.key.length > 1 ? e.key : e.key.toLowerCase();
    const dir = KEYMAP[key];

    if (dir) {
      e.preventDefault();
      this.steer(dir[0], dir[1]);
      return;
    }

    if (e.code === "Space" || e.key === "Shift") {
      e.preventDefault();
      this.sprint();
      return;
    }

    if (e.key === "v" || e.key === "V") {
      this.toggleCamera();
    }
  };

  private onTouchStart = (e: TouchEvent) => {
    if (!e.touches[0]) return;
    this.touchStart = [e.touches[0].clientX, e.touches[0].clientY];
  };

  private onTouchMove = (e: TouchEvent) => {
    if (!this.touchStart || !e.touches[0]) return;

    const dx = e.touches[0].clientX - this.touchStart[0];
    const dy = e.touches[0].clientY - this.touchStart[1];

    if (Math.hypot(dx, dy) > 22) {
      if (Math.abs(dx) > Math.abs(dy)) {
        this.steer(Math.sign(dx), 0);
      } else {
        this.steer(0, Math.sign(dy));
      }

      this.touchStart = [e.touches[0].clientX, e.touches[0].clientY];
    }
  };

  /* ---------------- game loop ---------------- */

  private loop = (now: number) => {
    if (this.disposed) return;

    this.raf = requestAnimationFrame(this.loop);

    const dt = Math.min(50, now - this.last);
    this.last = now;

    if (this.netMode) {
      if (this.phase === "play") {
        this.acc = Math.min(TICK_MS, now - this.lastTickAt);
      }

      this.syncTiles();
    } else if (this.phase === "countdown") {
      this.updateCountdown(now);
    } else if (this.phase === "play") {
      this.acc += dt;

      while (this.acc >= TICK_MS) {
        this.acc -= TICK_MS;

        const result = step(this.engine);
        this.handleEvents(result.events);

        const me = this.engine.players[0];
        if (me && me.spr > 0) {
          this.spawnPuff(me);
        }
      }

      this.syncTiles();

      const rem = Math.max(
        0,
        this.config.durationS - (now - this.playStart) / 1000
      );

      if (rem <= 0 || isOver(this.engine)) {
        this.endRound();
      }

      this.updateHud(now);
    } else {
      this.syncTiles();
    }

    this.draw(now, dt);
  };

  private updateCountdown(now: number) {
    const e = (now - this.countdownStart) / 1000;

    if (e >= 4) {
      this.phase = "play";
      this.playStart = now;
      this.last = now;
      this.acc = 0;

      useHudStore.setState({ phase: "play" });
      useHudStore
        .getState()
        .showToast("Hit SPACE to sprint - your biggest edge", "#4ade9c");

      this.blip(660, 0.15, "square", 0.06);
      return;
    }

    const n = 3 - Math.floor(e);
    const txt = n > 0 ? String(n) : "GO!";

    if (txt !== this.lastCountdownText) {
      this.lastCountdownText = txt;
      useHudStore.setState({
        phase: "countdown",
        countdown: txt,
      });
      this.blip(n > 0 ? 330 : 660, 0.15, "square", 0.06);
    }
  }

  private updateHud(now: number) {
    if (now - this.lastHud < 100) return;
    this.lastHud = now;

    const total = this.size * this.size;

    const rows = [...this.engine.players]
      .sort((a, b) => b.score - a.score)
      .map((p, rank) => ({
        i: p.i,
        name: p.name,
        color: this.playerColors[p.i],
        pct: (p.score / total) * 100,
        me: p.i === 0,
        rank,
      }));

    const me = this.engine.players[0];

    let mode: "ready" | "running" | "recharging" = "ready";
    let progress = 1;

    if (me.spr > 0) {
      mode = "running";
      progress = me.spr / me.sprMax;
    } else if (me.cd > 0) {
      mode = "recharging";
      progress = 1 - me.cd / SPRINT_CD_S;
    }

    let time: number = this.config.durationS;
    let low = false;

    if (this.phase === "play") {
      const rem = Math.max(
        0,
        this.config.durationS - (now - this.playStart) / 1000
      );
      time = Math.ceil(rem);
      low = rem <= 10;
    }

    useHudStore.setState({
      leaderboard: rows,
      sprint: {
        mode,
        progress,
        shield: me.shield,
      },
      time,
      low,
    });
  }

  private endRound() {
    if (this.phase === "over") return;

    this.phase = "over";
    this.blip(520, 0.4, "triangle", 0.08);

    const total = this.size * this.size;
    const sorted = [...this.engine.players].sort((a, b) => b.score - a.score);
    const winner = sorted[0];

    useHudStore.setState({
      phase: "over",
      time: 0,
      low: false,
      results: {
        title: winner.i === 0 ? "YOU WIN!" : `${winner.name.toUpperCase()} WINS`,
        sub:
          winner.i === 0
            ? "Territory secured. Nicely done."
            : "Better luck next round.",
        rows: sorted.map((p, rank) => ({
          rank,
          name: p.name,
          color: this.playerColors[p.i],
          pct: (p.score / total) * 100,
          me: p.i === 0,
        })),
        winnerColor: this.playerColors[winner.i],
      },
    });
  }

  /* ---------------- engine events ---------------- */

  private handleEvents(events: GameEvent[]) {
    for (const ev of events) {
      switch (ev.type) {
        case "claim": {
          if (ev.prevOwner >= 0) {
            this.spawnStealFx(ev.k, ev.owner);

            if (ev.owner === 0) {
              const streak = this.engine.players[0].streak;
              this.blip(420 + Math.min(streak, 12) * 45, 0.09);
            }
          } else if (ev.owner === 0) {
            this.blip(260 + Math.random() * 30, 0.04, "square", 0.03);
          }
          break;
        }

        case "blocked": {
          const x = ev.k % this.size;
          const y = Math.floor(ev.k / this.size);
          this.spawnBlocked(x, y);

          const now = performance.now();
          if (ev.attacker === 0 && now - this.lastBlockedToast > 1500) {
            this.lastBlockedToast = now;
            useHudStore
              .getState()
              .showToast("Shielded tiles can't be stolen", PT.shield.col);
            this.blip(150, 0.12, "square", 0.05);
          }
          break;
        }

        case "grab": {
          const p = this.engine.players[ev.pIdx];
          const info = PT[ev.puType];

          if (ev.pIdx === 0) {
            useHudStore.getState().showToast(info.msg, info.col);
          } else {
            useHudStore
              .getState()
              .showToast(`${p.name} grabbed ${info.icon}`, info.col);
          }

          if (ev.pIdx === 0) {
            if (ev.puType === "bomb") this.blip(110, 0.4, "sawtooth", 0.09);
            if (ev.puType === "turbo") this.blip(880, 0.25, "triangle", 0.07);
            if (ev.puType === "shield") this.blip(700, 0.3, "sine", 0.08);
          }
          break;
        }

        case "sprintStart": {
          if (ev.pIdx === 0) this.blip(560, 0.12, "triangle", 0.06);
          break;
        }

        case "puSpawn": {
          this.blip(900, 0.08, "sine", 0.03);
          break;
        }

        case "streak": {
          if (ev.pIdx === 0) {
            this.shake = 0.25;
            this.blip(180, 0.18, "sawtooth", 0.06);
          }
          break;
        }

        case "bomb": {
          this.shake = ev.pIdx === 0 ? 0.5 : 0.2;
          break;
        }

        default:
          break;
      }
    }
  }

  /* ---------------- tile sync ---------------- */

  private syncTiles() {
    this.updateShieldDirty();

    for (let k = 0; k < this.target.length; k++) {
      const o = this.engine.cells[k];
      if (this.target[k] !== o) {
        this.prevOwner[k] = this.target[k];
        this.target[k] = o;
        this.fade[k] = 0;
      }
    }
  }

  private updateShieldDirty() {
    for (const p of this.engine.players) {
      const on = p.shield > 0;
      if (on !== this.lastShields[p.i]) {
        this.lastShields[p.i] = on;
        this.allTilesDirty = true;
      }
    }
  }

  private setTile(k: number, f: number) {
    const o = this.target[k];
    const po = this.prevOwner[k];

    const from = po < 0 ? this.emptyColor : this.playerColor3[po];
    const to = o < 0 ? this.emptyColor : this.playerColor3[o];

    this.tmpColor.copy(from).lerp(to, f);

    if (o >= 0 && this.engine.players[o].shield > 0) {
      this.tmpColor.lerp(this.shieldColor, 0.4 * f);
    }

    const hFrom = po < 0 ? 0.16 : 0.3;
    const hTo = o < 0 ? 0.16 : 0.3;
    const h = hFrom + (hTo - hFrom) * f;

    const lift = f < 1 ? Math.sin(Math.PI * f) * 0.25 : 0;

    const x = (k % this.size) - this.size / 2 + 0.5;
    const z = Math.floor(k / this.size) - this.size / 2 + 0.5;

    this.dummy.position.set(x, h / 2 + lift, z);
    this.dummy.scale.set(0.94, h, 0.94);
    this.dummy.updateMatrix();

    this.tiles.setMatrixAt(k, this.dummy.matrix);
    this.tiles.setColorAt(k, this.tmpColor);
  }

  /* ---------------- draw ---------------- */

  private draw(now: number, dt: number) {
    this.updateTiles(dt);
    this.updatePlayers(dt, now);
    this.updatePowerups(dt, now);
    this.updateRings(dt);
    this.updateParticles(dt);
    this.updateCamera(dt);
    this.drawMinimap(now);

    this.renderer.render(this.scene, this.camera);
  }

  private updateTiles(dt: number) {
    let update = this.allTilesDirty;

    for (let k = 0; k < this.fade.length; k++) {
      let f = this.fade[k];

      if (f < 1) {
        f = this.fade[k] = Math.min(1, f + dt / 150);
        this.setTile(k, f);
        update = true;
      } else if (this.allTilesDirty) {
        this.setTile(k, 1);
      }
    }

    if (update) {
      this.tiles.instanceMatrix.needsUpdate = true;
      if (this.tiles.instanceColor) {
        this.tiles.instanceColor.needsUpdate = true;
      }
      this.allTilesDirty = false;
    }
  }

  private updatePlayers(dt: number, now: number) {
    const t =
      this.phase === "play" ? Math.min(1, this.acc / TICK_MS) : 1;

    for (const p of this.engine.players) {
      const viz = this.playerViz[p.i];
      if (!viz) continue;

      let moving = false;

      if (this.netMode) {
        const targetX = p.x - this.size / 2 + 0.5;
        const targetZ = p.y - this.size / 2 + 0.5;
        const targetY = 0.3 + this.liftAt(p.y * this.size + p.x);

        this.tmpTarget.set(targetX, targetY, targetZ);

        const distSq = viz.group.position.distanceToSquared(this.tmpTarget);

        moving = this.phase === "play" && distSq > 0.0005;

        const alpha = 1 - Math.exp(-dt / 65);
        viz.group.position.lerp(this.tmpTarget, alpha);
      } else {
        const x =
          p.px + (p.x - p.px) * t - this.size / 2 + 0.5;
        const z =
          p.py + (p.y - p.py) * t - this.size / 2 + 0.5;
        const y = 0.3 + this.liftAt(p.y * this.size + p.x);

        viz.group.position.set(x, y, z);

        moving =
          this.phase === "play" && (p.x !== p.px || p.y !== p.py);
      }

      viz.phase +=
        (dt / 1000) * (moving ? (p.spr > 0 ? 26 : 16) : 0);

      const targetSwing = moving ? Math.sin(viz.phase) : 0;
      viz.swing += (targetSwing - viz.swing) * Math.min(1, dt / 50);

      viz.legL.rotation.x = viz.swing * 0.9;
      viz.legR.rotation.x = -viz.swing * 0.9;
      viz.armL.rotation.x = -viz.swing * 0.9;
      viz.armR.rotation.x = viz.swing * 0.9;

      viz.inner.position.y = Math.abs(viz.swing) * 0.1;

      const leanTarget = p.spr > 0 ? 0.35 : 0;
      viz.inner.rotation.x +=
        (leanTarget - viz.inner.rotation.x) * Math.min(1, dt / 80);

      let d = Math.atan2(p.dx, p.dy) - viz.group.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      viz.group.rotation.y += d * Math.min(1, dt / 55);

      viz.shield.visible =
        p.shield > 0 &&
        (p.shield > 1.5 || Math.floor(now / 110) % 2 === 0);
    }
  }

  private updatePowerups(dt: number, now: number) {
    const active = new Set<number>();

    for (const pu of this.engine.pu) {
      active.add(pu.id);

      let viz = this.puViz.get(pu.id);

      if (!viz) {
        const made = this.makePuMesh(pu.type);
        this.dynamic.add(made.group);
        viz = {
          ...made,
          age: 0,
        };
        this.puViz.set(pu.id, viz);
      }

      const x = (pu.k % this.size) - this.size / 2 + 0.5;
      const z = Math.floor(pu.k / this.size) - this.size / 2 + 0.5;
      viz.group.position.set(x, 0, z);

      viz.age = Math.min(1, viz.age + dt / 300);
      viz.group.scale.setScalar(viz.age);

      viz.core.rotation.y += dt * 0.003;
      viz.core.position.y = 0.9 + Math.sin(now / 280 + pu.k) * 0.12;
      viz.ring.scale.setScalar(1.5 + Math.sin(now / 200) * 0.2);
    }

    for (const [id, viz] of this.puViz) {
      if (!active.has(id)) {
        this.dynamic.remove(viz.group);
        viz.coreGeo.dispose();
        (viz.core.material as THREE.Material).dispose();
        (viz.ring.material as THREE.Material).dispose();
        this.puViz.delete(id);
      }
    }
  }

  private updateRings(dt: number) {
    this.rings = this.rings.filter((r) => {
      r.t += dt / 450;
      r.mesh.scale.setScalar(1 + r.t * 4);

      const mat = r.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.85 * (1 - r.t);

      if (r.t >= 1) {
        this.dynamic.remove(r.mesh);
        mat.dispose();
        return false;
      }

      return true;
    });
  }

  private updateParticles(dt: number) {
    this.particles = this.particles.filter((c) => {
      const u = c.userData as {
        v: THREE.Vector3;
        l: number;
      };

      u.l += dt / 1000;
      u.v.y -= (14 * dt) / 1000;
      c.position.addScaledVector(u.v, dt / 1000);

      if (u.l > 0.6 || c.position.y < 0.1) {
        this.dynamic.remove(c);
        return false;
      }

      return true;
    });
  }

  private updateCamera(dt: number) {
    const me = this.playerViz[0];
    if (!me) return;

    const asp = this.camera.aspect;

    const follow = this.phase === "play" && this.userFollow;

    const fk = Math.max(1, 0.8 / asp);
    const ok = Math.max(1, 1 / asp) * 1.12;

    const target = follow ? me.group.position : new THREE.Vector3(0, 0, 0);

    const offset = follow
      ? new THREE.Vector3(0, 12 * fk, 9.5 * fk)
      : new THREE.Vector3(0, 44 * ok, 30 * ok);

    const desired = target.clone().add(offset);

    const rate = follow ? 7 : 3;
    const alpha = this.snap ? 1 : 1 - Math.exp((-dt / 1000) * rate);

    this.camPos.lerp(desired, alpha);
    this.camTar.lerp(target, alpha);
    this.snap = false;

    this.camera.position.copy(this.camPos);

    if (this.shake > 0) {
      this.shake -= dt / 1000;
      const s = this.shake * 0.9;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
    }

    const mePlayer = this.engine.players[0];
    const targetFov = mePlayer && mePlayer.spr > 0 ? 48 : 40;
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt / 120);
    this.camera.updateProjectionMatrix();

    this.camera.lookAt(this.camTar);
  }

  private drawMinimap(now: number) {
    if (!this.mmCtx) return;
    if (now - this.lastMM < 90) return;
    this.lastMM = now;

    const ctx = this.mmCtx;
    const canvas = ctx.canvas;
    const sc = canvas.width / this.size;

    ctx.fillStyle = "#10142a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < this.engine.cells.length; i++) {
      const o = this.engine.cells[i];
      if (o >= 0) {
        ctx.fillStyle = this.playerColors[o];
        ctx.fillRect(
          (i % this.size) * sc,
          Math.floor(i / this.size) * sc,
          sc,
          sc
        );
      }
    }

    for (const u of this.engine.pu) {
      const x = (u.k % this.size) + 0.5;
      const y = Math.floor(u.k / this.size) + 0.5;

      ctx.fillStyle = PT[u.type].col;
      ctx.beginPath();
      ctx.arc(x * sc, y * sc, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    for (const p of this.engine.players) {
      ctx.fillStyle = this.playerColors[p.i];
      ctx.beginPath();
      ctx.arc((p.x + 0.5) * sc, (p.y + 0.5) * sc, p.bot ? 3 : 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "#fff";
      ctx.lineWidth = p.bot ? 1 : 2;
      ctx.stroke();
    }
  }

  /* ---------------- helpers ---------------- */

  private liftAt(k: number) {
    return this.fade[k] < 1 ? Math.sin(Math.PI * this.fade[k]) * 0.25 : 0;
  }

  private resize() {
    const parent = this.canvas.parentElement;
    const w = parent ? parent.clientWidth : this.canvas.clientWidth;
    const h = parent ? parent.clientHeight : this.canvas.clientHeight;

    if (!w || !h) return;

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private blip(
    freq: number,
    dur = 0.07,
    type: OscillatorType = "square",
    vol = 0.05
  ) {
    if (this.muted || !this.audio) return;

    const o = this.audio.createOscillator();
    const g = this.audio.createGain();

    o.type = type;
    o.frequency.value = freq;

    g.gain.setValueAtTime(vol, this.audio.currentTime);
    g.gain.exponentialRampToValueAtTime(
      0.0001,
      this.audio.currentTime + dur
    );

    o.connect(g);
    g.connect(this.audio.destination);

    o.start();
    o.stop(this.audio.currentTime + dur);
  }

  /* ---------------- meshes ---------------- */

  private makeChar(p: Player, color: string): PlayerViz {
    const group = new THREE.Group();
    const inner = new THREE.Group();
    inner.scale.setScalar(1.05);
    group.add(inner);

    const shirt = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.6,
    });
    const skin = new THREE.MeshStandardMaterial({
      color: 0xffd7b5,
      roughness: 0.6,
    });
    const dark = new THREE.MeshStandardMaterial({
      color: 0x2a2f55,
      roughness: 0.6,
    });
    const eye = new THREE.MeshStandardMaterial({
      color: 0x161a33,
      roughness: 0.6,
    });

    const addBox = (
      w: number,
      h: number,
      d: number,
      m: THREE.Material,
      x: number,
      y: number,
      z: number,
      parent: THREE.Object3D
    ) => {
      const mesh = new THREE.Mesh(this.boxGeo, m);
      mesh.scale.set(w, h, d);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };

    addBox(0.5, 0.52, 0.3, shirt, 0, 0.7, 0, inner);
    addBox(0.46, 0.42, 0.42, skin, 0, 1.17, 0, inner);
    addBox(0.5, 0.14, 0.46, shirt, 0, 1.4, 0, inner);
    addBox(0.46, 0.05, 0.22, shirt, 0, 1.34, 0.3, inner);
    addBox(0.07, 0.1, 0.02, eye, -0.11, 1.18, 0.22, inner);
    addBox(0.07, 0.1, 0.02, eye, 0.11, 1.18, 0.22, inner);

    const limb = (
      x: number,
      y: number,
      w: number,
      h: number,
      m: THREE.Material
    ) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      inner.add(pivot);

      const mesh = new THREE.Mesh(this.boxGeo, m);
      mesh.scale.set(w, h, w);
      mesh.position.set(0, -h / 2, 0);
      mesh.castShadow = true;
      pivot.add(mesh);

      return pivot;
    };

    const legL = limb(-0.13, 0.44, 0.18, 0.44, dark);
    const legR = limb(0.13, 0.44, 0.18, 0.44, dark);
    const armL = limb(-0.34, 0.92, 0.14, 0.42, skin);
    const armR = limb(0.34, 0.92, 0.14, 0.42, skin);

    const glow = new THREE.Mesh(
      this.circleGeo,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.4,
      })
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.03;
    group.add(glow);

    if (p.i === 0) {
      const ring = new THREE.Mesh(
        this.localRingGeo,
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.9,
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.04;
      group.add(ring);
    }

    const shield = new THREE.Mesh(
      this.shieldGeo,
      new THREE.MeshBasicMaterial({
        color: 0x7df9ff,
        transparent: true,
        opacity: 0.22,
      })
    );
    shield.position.y = 0.9;
    shield.visible = false;
    group.add(shield);

    group.add(this.label(p.i === 0 ? "YOU" : p.name, color));

    this.dynamic.add(group);

    return {
      group,
      inner,
      legL,
      legR,
      armL,
      armR,
      shield,
      phase: 0,
      swing: 0,
    };
  }

  private label(txt: string, col: string) {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 64;

    const x = c.getContext("2d")!;
    x.font = "700 30px Inter, sans-serif";
    x.textAlign = "center";
    x.textBaseline = "middle";

    const w = Math.min(250, x.measureText(txt).width + 30);

    x.fillStyle = "rgba(11,14,26,.8)";
    x.fillRect(128 - w / 2, 8, w, 48);

    x.fillStyle = col;
    x.fillRect(128 - w / 2, 8, 5, 48);

    x.fillStyle = "#fff";
    x.fillText(txt, 128 + 2, 33);

    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        depthTest: false,
      })
    );

    sprite.scale.set(2.6, 0.65, 1);
    sprite.position.y = 2.15;
    sprite.renderOrder = 5;

    return sprite;
  }

  private makePuMesh(type: PowerUpType) {
    const color = new THREE.Color(PT[type].col);
    const group = new THREE.Group();

    let geo: THREE.BufferGeometry;

    if (type === "bomb") {
      geo = new THREE.SphereGeometry(0.3, 14, 10);
    } else if (type === "turbo") {
      geo = new THREE.OctahedronGeometry(0.4);
    } else {
      geo = new THREE.IcosahedronGeometry(0.36);
    }

    const core = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.8,
        roughness: 0.3,
      })
    );

    core.castShadow = true;
    core.position.y = 0.9;
    group.add(core);

    const ring = new THREE.Mesh(
      this.ringGeo,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
      })
    );

    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.38;
    group.add(ring);

    return {
      group,
      core,
      ring,
      coreGeo: geo,
    };
  }

  /* ---------------- FX ---------------- */

  private spawnStealFx(k: number, owner: number) {
    const x = k % this.size;
    const y = Math.floor(k / this.size);

    const ring = new THREE.Mesh(
      this.ringGeo,
      new THREE.MeshBasicMaterial({
        color: this.playerColors[owner],
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
      })
    );

    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x - this.size / 2 + 0.5, 0.42, y - this.size / 2 + 0.5);

    this.dynamic.add(ring);
    this.rings.push({ mesh: ring, t: 0 });

    for (let i = 0; i < 4; i++) {
      const cube = new THREE.Mesh(
        this.boxGeo,
        this.playerBasicMaterials[owner]
      );

      cube.scale.setScalar(0.14);
      cube.position.set(
        x - this.size / 2 + 0.5,
        0.4,
        y - this.size / 2 + 0.5
      );

      cube.userData = {
        v: new THREE.Vector3(
          (Math.random() - 0.5) * 3,
          2 + Math.random() * 3,
          (Math.random() - 0.5) * 3
        ),
        l: 0,
      };

      this.dynamic.add(cube);
      this.particles.push(cube);
    }
  }

  private spawnBlocked(x: number, y: number) {
    const ring = new THREE.Mesh(
      this.ringGeo,
      new THREE.MeshBasicMaterial({
        color: 0x7df9ff,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
      })
    );

    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x - this.size / 2 + 0.5, 0.5, y - this.size / 2 + 0.5);

    this.dynamic.add(ring);
    this.rings.push({ mesh: ring, t: 0 });
  }

  private spawnPuff(p: Player) {
    for (let i = 0; i < 2; i++) {
      const cube = new THREE.Mesh(
        this.boxGeo,
        this.playerBasicMaterials[p.i]
      );

      cube.scale.setScalar(0.12);
      cube.position.set(
        p.px - this.size / 2 + 0.5,
        0.4,
        p.py - this.size / 2 + 0.5
      );

      cube.userData = {
        v: new THREE.Vector3(
          (Math.random() - 0.5) * 2,
          1 + Math.random() * 2,
          (Math.random() - 0.5) * 2
        ),
        l: 0,
      };

      this.dynamic.add(cube);
      this.particles.push(cube);
    }
  }

  /* ---------------- net mode ---------------- */

  startNet() {
    this.netMode = true;
    this.phase = "play";

    this.playStart = performance.now();
    this.last = performance.now();
    this.lastTickAt = performance.now();
    this.acc = 0;

    this.audio?.resume().catch(() => {});

    useHudStore.getState().reset(this.config.durationS);
    useHudStore.setState({ phase: "play" });

    this.raf = requestAnimationFrame(this.loop);
  }

  netApplySnapshot(snapshot: SnapshotPayload, map: number[]) {
    const binary = atob(snapshot.cellsB64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const cells = new Int8Array(bytes.buffer);

    for (let k = 0; k < cells.length; k++) {
      const o = cells[k];
      this.engine.cells[k] = o < 0 ? -1 : map[o] ?? -1;
    }

    this.target = new Int8Array(this.engine.cells);
    this.prevOwner = new Int8Array(this.engine.cells);
    this.fade.fill(1);
    this.allTilesDirty = true;

    for (const tp of snapshot.players) {
      const li = map[tp.i] ?? tp.i;
      const p = this.engine.players[li];

      if (!p) continue;

      p.px = p.x = tp.x;
      p.py = p.y = tp.y;

      p.dx = tp.dx;
      p.dy = tp.dy;

      p.spr = tp.spr;
      if (tp.spr > p.sprMax) p.sprMax = tp.spr;

      p.cd = tp.cd;
      p.shield = tp.sh;
      p.score = tp.sc;

      const viz = this.playerViz[li];
      if (viz) {
        viz.group.position.set(
          tp.x - this.size / 2 + 0.5,
          0.3,
          tp.y - this.size / 2 + 0.5
        );
      }
    }

    this.engine.pu = snapshot.pu.map((u) => ({
      id: u.id,
      k: u.k,
      type: u.type,
    }));

    this.updateNetHud(this.config.durationS);
  }

  netApplyTick(tick: TickPayload, map: number[]) {
    if (this.phase !== "play") return;

    this.lastTickAt = performance.now();
    this.acc = 0;

    for (let i = 0; i < tick.cells.length; i += 2) {
      const k = tick.cells[i];
      const o = tick.cells[i + 1];
      this.engine.cells[k] = o < 0 ? -1 : map[o] ?? -1;
    }

    for (const tp of tick.players) {
      const li = map[tp.i] ?? tp.i;
      const p = this.engine.players[li];

      if (!p) continue;

      p.px = p.x;
      p.py = p.y;

      p.x = tp.x;
      p.y = tp.y;

      p.dx = tp.dx;
      p.dy = tp.dy;

      p.spr = tp.spr;
      if (tp.spr > p.sprMax) p.sprMax = tp.spr;

      p.cd = tp.cd;
      p.shield = tp.sh;
      p.score = tp.sc;
    }

    this.engine.pu = tick.pu.map((u) => ({
      id: u.id,
      k: u.k,
      type: u.type,
    }));

    if (tick.ev?.length) {
      const remapped = tick.ev.map((ev) => this.remapEvent(ev, map));
      this.handleEvents(remapped);
    }

    this.updateNetHud(tick.rem);
  }

  private remapEvent(ev: GameEvent, map: number[]): GameEvent {
    const mi = (idx: number) => (idx < 0 ? -1 : map[idx] ?? -1);

    switch (ev.type) {
      case "claim":
        return {
          ...ev,
          owner: mi(ev.owner),
          prevOwner: mi(ev.prevOwner),
        };

      case "blocked":
        return {
          ...ev,
          attacker: mi(ev.attacker),
          defender: mi(ev.defender),
        };

      case "grab":
        return {
          ...ev,
          pIdx: mi(ev.pIdx),
        };

      case "sprintStart":
        return {
          ...ev,
          pIdx: mi(ev.pIdx),
        };

      case "sprintEnd":
        return {
          ...ev,
          pIdx: mi(ev.pIdx),
        };

      case "streak":
        return {
          ...ev,
          pIdx: mi(ev.pIdx),
        };

      case "bomb":
        return {
          ...ev,
          pIdx: mi(ev.pIdx),
        };

      default:
        return ev;
    }
  }

  private updateNetHud(rem: number) {
    const total = this.size * this.size;

    const rows = [...this.engine.players]
      .sort((a, b) => b.score - a.score)
      .map((p, rank) => ({
        i: p.i,
        name: p.name,
        color: this.playerColors[p.i],
        pct: (p.score / total) * 100,
        me: p.i === 0,
        rank,
      }));

    const me = this.engine.players[0];

    let mode: "ready" | "running" | "recharging" = "ready";
    let progress = 1;

    if (me.spr > 0) {
      mode = "running";
      progress = me.spr / me.sprMax;
    } else if (me.cd > 0) {
      mode = "recharging";
      progress = 1 - me.cd / SPRINT_CD_S;
    }

    useHudStore.setState({
      leaderboard: rows,
      sprint: {
        mode,
        progress,
        shield: me.shield,
      },
      time: Math.ceil(rem),
      low: rem <= 10,
    });
  }
}
