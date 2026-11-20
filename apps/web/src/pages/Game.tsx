import { useEffect, useRef, useState } from "react";
import {
  COLORS,
  type GameConfig,
  type SlotConfig,
} from "@pixel-turf/shared";
import { GameCanvas } from "../game/GameCanvas";
import type { LocalGameApi } from "../game/LocalGame";
import { useHudStore } from "../game/hudStore";

type BotLevel = "easy" | "normal" | "hard";

export default function GamePage() {
  const [screen, setScreen] = useState<"lobby" | "game">("lobby");
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [gameId, setGameId] = useState(0);

  const apiRef = useRef<LocalGameApi | null>(null);

  const startGame = (opts: {
    name: string;
    colorId: number;
    diff: BotLevel;
  }) => {
    const botNames = ["Nova", "Blip", "Zed"];
    const botColors = [0, 1, 2, 3, 4, 5]
      .filter((i) => i !== opts.colorId)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);

    const slots: SlotConfig[] = [
      {
        kind: "human",
        name: opts.name.trim() || "You",
        skinId: "classic",
        colorId: opts.colorId,
      },
      ...botNames.map((name, i) => ({
        kind: "bot" as const,
        name,
        skinId: "classic",
        colorId: botColors[i],
        botLevel: opts.diff,
      })),
    ];

    const cfg: GameConfig = {
      size: 40,
      durationS: 90,
      sprint: true,
      powerups: true,
      seed: Math.floor(Math.random() * 1_000_000_000),
      slots,
    };

    setConfig(cfg);
    setGameId((v) => v + 1);
    setScreen("game");
  };

  const restart = () => {
    if (!config) return;

    setConfig({
      ...config,
      seed: Math.floor(Math.random() * 1_000_000_000),
    });
    setGameId((v) => v + 1);
  };

  const exit = () => {
    setScreen("lobby");
    setConfig(null);
    useHudStore.setState({ phase: "menu" });
  };

  if (screen === "lobby" || !config) {
    return (
      <>
        <BgLoop />
        <Lobby onStart={startGame} />
      </>
    );
  }

  return (
    <div className="game">
      <HudBar apiRef={apiRef} />

      <div className="main">
        <GameCanvas key={gameId} config={config} apiRef={apiRef} />
        <SideBoard config={config} />
      </div>

      <Dpad apiRef={apiRef} />
      <CountdownOverlay />
      <ResultsOverlay onRestart={restart} onExit={exit} />
    </div>
  );
}

/* ---------------- Lobby ---------------- */

function Lobby({
  onStart,
}: {
  onStart: (opts: {
    name: string;
    colorId: number;
    diff: BotLevel;
  }) => void;
}) {
  const [name, setName] = useState("You");
  const [colorId, setColorId] = useState(0);
  const [diff, setDiff] = useState<BotLevel>("easy");

  return (
    <div className="lobby">
      <div className="card">
        <h1 className="title">
          PIXEL
          <br />
          TURF
        </h1>

        <p className="sub">
          Paint the grid. Steal rivals' cells. Own the most in 90 seconds.
        </p>

        <label className="label">Your name</label>
        <input
          className="input"
          maxLength={10}
          value={name}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
        />

        <label className="label">Your color</label>
        <div className="dots">
          {COLORS.map((c, i) => (
            <div
              key={c}
              className={`dot ${i === colorId ? "on" : ""}`}
              style={{
                background: c,
                ["--c" as any]: c,
              }}
              onClick={() => setColorId(i)}
            />
          ))}
        </div>

        <label className="label">Bot difficulty</label>
        <div className="seg">
          {(["easy", "normal", "hard"] as BotLevel[]).map((lvl) => (
            <button
              key={lvl}
              className={diff === lvl ? "on" : ""}
              onClick={() => setDiff(lvl)}
            >
              {lvl[0].toUpperCase() + lvl.slice(1)}
            </button>
          ))}
        </div>

        <button
          className="btn"
          onClick={() => onStart({ name, colorId, diff })}
        >
          Start round
        </button>

        <p className="hint">
          Arrows / WASD or swipe Â· Space to sprint Â· grab ðŸ’£ âš¡ ðŸ›¡ Â· 3 local bots
        </p>
      </div>
    </div>
  );
}

/* ---------------- HUD ---------------- */

function HudBar({
  apiRef,
}: {
  apiRef: React.MutableRefObject<LocalGameApi | null>;
}) {
  const time = useHudStore((s) => s.time);
  const duration = useHudStore((s) => s.duration);
  const low = useHudStore((s) => s.low);
  const muted = useHudStore((s) => s.muted);

  return (
    <div className="hud">
      <span className="px room-label">OFFLINE</span>

      <div className="tbar">
        <div
          className={`tfill ${low ? "low" : ""}`}
          style={{
            width: `${Math.max(0, Math.min(100, (time / duration) * 100))}%`,
          }}
        />
      </div>

      <div className="ttxt">{time}</div>

      <div className="ping">
        <i />
        <span>12 ms</span>
      </div>

      <button
        className="icon-btn"
        onClick={() => {
          const next = apiRef.current?.toggleMute();
          if (typeof next === "boolean") {
            useHudStore.setState({ muted: next });
          }
        }}
      >
        {muted ? "ðŸ”‡" : "ðŸ”Š"}
      </button>

      <button
        className="icon-btn"
        onClick={() => apiRef.current?.toggleCamera()}
        title="Camera (V)"
      >
        ðŸŽ¥
      </button>
    </div>
  );
}

function SideBoard({ config }: { config: GameConfig }) {
  const rows = useHudStore((s) => s.leaderboard);
  const byIndex = new Map(rows.map((r) => [r.i, r]));
  const rh = useRowHeight();

  return (
    <div className="side">
      <h3>TERRITORY</h3>

      <div
        className="lb"
        style={{ height: config.slots.length * rh }}
      >
        {config.slots.map((slot, i) => {
          const row = byIndex.get(i);
          const rank = row?.rank ?? i;
          const pct = row?.pct ?? 0;
          const color = COLORS[slot.colorId % COLORS.length];

          return (
            <div
              key={i}
              className={`row ${i === 0 ? "me" : ""}`}
              style={{
                transform: `translateY(${rank * rh}px)`,
                height: rh,
              }}
            >
              <i
                className="sw"
                style={{
                  background: color,
                  boxShadow: `0 0 10px ${color}`,
                }}
              />
              <span className="nm">{slot.name}</span>
              <div className="bar">
                <b
                  style={{
                    width: `${Math.min(100, pct * 2.2)}%`,
                    background: color,
                  }}
                />
              </div>
              <em>{pct.toFixed(1)}%</em>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function useRowHeight() {
  const [rh, setRh] = useState(window.innerWidth > 760 ? 40 : 26);

  useEffect(() => {
    const onResize = () => {
      setRh(window.innerWidth > 760 ? 40 : 26);
    };

    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return rh;
}

/* ---------------- Controls ---------------- */

function Dpad({
  apiRef,
}: {
  apiRef: React.MutableRefObject<LocalGameApi | null>;
}) {
  const steer = (dx: number, dy: number) => {
    apiRef.current?.steer(dx, dy);
  };

  return (
    <div className="dpad">
      <span />
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          steer(0, -1);
        }}
      >
        â–²
      </button>
      <span />

      <button
        onPointerDown={(e) => {
          e.preventDefault();
          steer(-1, 0);
        }}
      >
        â—€
      </button>
      <span />
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          steer(1, 0);
        }}
      >
        â–¶
      </button>

      <span />
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          steer(0, 1);
        }}
      >
        â–¼
      </button>
      <span />
    </div>
  );
}

/* ---------------- Overlays ---------------- */

function CountdownOverlay() {
  const phase = useHudStore((s) => s.phase);
  const countdown = useHudStore((s) => s.countdown);

  if (phase !== "countdown") return null;

  return (
    <div className="overlay">
      <div
        key={countdown}
        className="countdown px"
        style={{
          color: countdown === "GO!" ? "#4ade9c" : "#e8ebff",
        }}
      >
        {countdown}
      </div>
    </div>
  );
}

function ResultsOverlay({
  onRestart,
  onExit,
}: {
  onRestart: () => void;
  onExit: () => void;
}) {
  const phase = useHudStore((s) => s.phase);
  const results = useHudStore((s) => s.results);

  if (phase !== "over" || !results) return null;

  return (
    <div className="overlay results-overlay">
      <Confetti color={results.winnerColor} />

      <div className="card results-card">
        <h1 className="title results-title">{results.title}</h1>
        <p className="sub">{results.sub}</p>

        <div>
          {results.rows.map((row, idx) => (
            <div
              key={idx}
              className="result-row"
              style={{
                animationDelay: `${300 + idx * 150}ms`,
              }}
            >
              <span className="rk">{idx + 1}</span>
              <i
                className="sw"
                style={{
                  background: row.color,
                  boxShadow: `0 0 10px ${row.color}`,
                }}
              />
              <span className="nm">
                {row.name}
                {row.me ? " (you)" : ""}
              </span>
              <span className="pc">{row.pct.toFixed(1)}%</span>
            </div>
          ))}
        </div>

        <button className="btn" onClick={onRestart}>
          Play again
        </button>
        <button className="btn ghost" onClick={onExit}>
          Back to lobby
        </button>
      </div>
    </div>
  );
}

function Confetti({ color }: { color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    let parts: {
      x: number;
      y: number;
      vx: number;
      vy: number;
      s: number;
      c: string;
      r: number;
    }[] = [];

    for (let i = 0; i < 160; i++) {
      parts.push({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2.4,
        vx: (Math.random() - 0.5) * 14,
        vy: -Math.random() * 14 - 3,
        s: 4 + Math.random() * 6,
        c: Math.random() < 0.5 ? color : COLORS[Math.floor(Math.random() * 6)],
        r: Math.random() * 6,
      });
    }

    let raf = 0;

    const frame = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      parts = parts.filter((p) => p.y < canvas.height + 20);

      for (const p of parts) {
        p.vy += 0.25;
        p.x += p.vx;
        p.y += p.vy;
        p.r += 0.2;

        ctx.fillStyle = p.c;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
        ctx.restore();
      }

      if (parts.length > 0) {
        raf = requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };

    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
    };
  }, [color]);

  return <canvas ref={ref} className="confetti-canvas" />;
}

/* ---------------- Background ---------------- */

function BgLoop() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const BN = 26;

    let cells = Array.from({ length: BN * BN }, () => ({
      c: -1,
      a: 0,
    }));

    let raf = 0;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    const loop = () => {
      const s = Math.max(canvas.width, canvas.height) / BN;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (let k = 0; k < 3; k++) {
        const cell = cells[Math.floor(Math.random() * cells.length)];
        cell.c = Math.floor(Math.random() * COLORS.length);
        cell.a = 0;
      }

      cells.forEach((cell, i) => {
        if (cell.c < 0) return;

        cell.a = Math.min(1, cell.a + 0.04);

        const x = (i % BN) * s;
        const y = Math.floor(i / BN) * s;

        ctx.globalAlpha = 0.35 * cell.a;
        ctx.fillStyle = COLORS[cell.c];
        ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
      });

      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(loop);
    };

    resize();
    loop();

    window.addEventListener("resize", resize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={ref} className="bg" />;
}
