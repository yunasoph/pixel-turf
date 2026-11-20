import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { useParams } from "react-router-dom";
import {
  COLORS,
  type GameConfig,
  type GameEndPayload,
  type GameStartPayload,
  type RoomStateDTO,
  type SnapshotPayload,
  type TickPayload,
} from "@pixel-turf/shared";
import { getPlayerId, socket } from "../net/socket";
import { LocalGame, type LocalGameApi } from "../game/LocalGame";
import { OnlineGameCanvas } from "../game/OnlineGameCanvas";
import { useHudStore } from "../game/hudStore";

type Stage = "lobby" | "countdown" | "game" | "results";

export default function OnlinePage() {
  const params = useParams<{ code?: string }>();

  const [stage, setStage] = useState<Stage>("lobby");
  const [room, setRoom] = useState<RoomStateDTO | null>(null);

  const [name, setName] = useState(
    () => localStorage.getItem("pixel-turf:name") || "You"
  );
  const [colorId, setColorId] = useState(0);

  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const [countdownText, setCountdownText] = useState("3");

  const [startPayload, setStartPayload] = useState<GameStartPayload | null>(
    null
  );
  const [localConfig, setLocalConfig] = useState<GameConfig | null>(null);
  const [mapping, setMapping] = useState<number[]>([]);
  const [results, setResults] = useState<GameEndPayload | null>(null);

  const [connected, setConnected] = useState(socket.connected);
  const [gameKey, setGameKey] = useState(0);

  const apiRef = useRef<LocalGameApi | null>(null);
  const netGameRef = useRef<LocalGame | null>(null);

  const mappingRef = useRef<number[]>([]);
  const selfGlobalRef = useRef(0);

  const roomCodeRef = useRef<string | null>(null);
  const inputSeq = useRef(0);

  const countdownInterval = useRef<number>(0);

  const profileRef = useRef({ name, colorId });

  useEffect(() => {
    profileRef.current = { name, colorId };
    localStorage.setItem("pixel-turf:name", name);
  }, [name, colorId]);

  useEffect(() => {
    const code = params.code?.toUpperCase();

    if (code && code.length === 7) {
      setJoinCode(code);
    }
  }, [params.code]);

  useEffect(() => {
    const clearCountdown = () => {
      if (countdownInterval.current) {
        clearInterval(countdownInterval.current);
        countdownInterval.current = 0;
      }
    };

    const onConnect = () => {
      setConnected(true);

      if (roomCodeRef.current) {
        socket.emit(
          "room:join",
          {
            playerId: getPlayerId(),
            name: profileRef.current.name,
            colorId: profileRef.current.colorId,
            code: roomCodeRef.current,
          },
          (res: any) => {
            if (res?.ok) {
              setRoom(res.state);
            }
          }
        );
      }
    };

    const onDisconnect = () => {
      setConnected(false);
    };

    const onRoomState = (state: RoomStateDTO) => {
      setRoom(state);
      roomCodeRef.current = state.code;

      setStage((prev) => {
        if (state.phase === "LOBBY" && prev !== "results") {
          return "lobby";
        }

        return prev;
      });
    };

    const onCountdown = () => {
      clearCountdown();

      setStage("countdown");
      setCountdownText("3");

      const start = performance.now();

      countdownInterval.current = window.setInterval(() => {
        const e = (performance.now() - start) / 1000;
        const n = 3 - Math.floor(e);

        if (e >= 4) {
          setCountdownText("GO!");
        } else {
          setCountdownText(n > 0 ? String(n) : "GO!");
        }
      }, 100);
    };

    const onStart = (payload: GameStartPayload) => {
      clearCountdown();

      const map = buildMapping(payload.config.slots.length, payload.selfIdx);

      mappingRef.current = map;
      selfGlobalRef.current = payload.selfIdx;

      setMapping(map);
      setLocalConfig(buildLocalConfig(payload.config, payload.selfIdx));
      setStartPayload(payload);
      setGameKey((k) => k + 1);

      setStage("game");
      setResults(null);
    };

    const onTick = (tick: TickPayload) => {
      netGameRef.current?.netApplyTick(tick, mappingRef.current);
    };

    const onSnapshot = (snap: SnapshotPayload) => {
      netGameRef.current?.netApplySnapshot(snap, mappingRef.current);
    };

    const onEnd = (payload: GameEndPayload) => {
      setResults(payload);
      setStage("results");
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);

    socket.on("room:state", onRoomState);

    socket.on("game:countdown", onCountdown);
    socket.on("game:start", onStart);
    socket.on("game:tick", onTick);
    socket.on("game:snapshot", onSnapshot);
    socket.on("game:end", onEnd);

    return () => {
      clearCountdown();

      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);

      socket.off("room:state", onRoomState);

      socket.off("game:countdown", onCountdown);
      socket.off("game:start", onStart);
      socket.off("game:tick", onTick);
      socket.off("game:snapshot", onSnapshot);
      socket.off("game:end", onEnd);
    };
  }, []);

  const onGameReady = useCallback((game: LocalGame) => {
    netGameRef.current = game;
    apiRef.current = game;

    game.netInput = {
      steer: (dx, dy) => {
        const dir = dirFromDxDy(dx, dy);
        inputSeq.current++;

        socket.emit("game:input", {
          seq: inputSeq.current,
          dir,
        });
      },

      sprint: () => {
        inputSeq.current++;

        socket.emit("game:sprint", {
          seq: inputSeq.current,
        });
      },
    };
  }, []);

  const playerId = getPlayerId();
  const isHost = room?.hostId === playerId;

  const doCreate = () => {
    setError("");

    socket.emit(
      "room:create",
      {
        playerId,
        name,
        colorId,
        settings: {
          maxPlayers: 4,
        },
      },
      (res: any) => {
        if (res.ok) {
          setRoom(res.state);
          roomCodeRef.current = res.state.code;
          setStage("lobby");
        } else {
          setError(res.message || "Failed to create room");
        }
      }
    );
  };

  const doJoin = () => {
    setError("");

    const code = joinCode.trim().toUpperCase();

    if (code.length !== 7) {
      setError("Room code should look like ABC-123");
      return;
    }

    socket.emit(
      "room:join",
      {
        playerId,
        name,
        colorId,
        code,
      },
      (res: any) => {
        if (res.ok) {
          setRoom(res.state);
          roomCodeRef.current = res.state.code;
          setStage("lobby");
        } else {
          setError(res.message || "Failed to join room");
        }
      }
    );
  };

  const doQuickPlay = () => {
    setError("");

    socket.emit(
      "queue:join",
      {
        name,
        colorId,
      },
      (res: any) => {
        if (res.ok) {
          setRoom(res.state);
          roomCodeRef.current = res.state.code;
          setStage("lobby");
        } else {
          setError(res.message || "Failed to quick play");
        }
      }
    );
  };

  const doLeave = () => {
    socket.emit("room:leave");

    roomCodeRef.current = null;

    setRoom(null);
    setStartPayload(null);
    setResults(null);
    setStage("lobby");
  };

  const startGame = () => {
    socket.emit("room:start");
  };

  const updateSettings = (patch: any) => {
    if (!isHost) return;
    socket.emit("room:settings", patch);
  };

  const presetBots = (count: number) => {
    if (!isHost) return;
    socket.emit("room:bot", { action: "preset", count });
  };

  const addBot = () => {
    if (!isHost) return;
    socket.emit("room:bot", { action: "add" });
  };

  const removeBot = () => {
    if (!isHost) return;
    socket.emit("room:bot", { action: "remove" });
  };

  const removeSpecificBot = (botPlayerId: string) => {
    if (!isHost) return;
    socket.emit("room:bot", {
      action: "remove",
      playerId: botPlayerId,
    });
  };

  const setBotLevel = (botPlayerId: string, level: string) => {
    if (!isHost) return;
    socket.emit("room:bot", {
      action: "set",
      playerId: botPlayerId,
      level,
    });
  };

  const copyLink = async () => {
    if (!room) return;

    const url = `${window.location.origin}/r/${room.code}`;

    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);

      setTimeout(() => {
        setCopied(false);
      }, 1200);
    } catch {}
  };

  if (stage === "countdown") {
    return (
      <div className="overlay">
        <div
          className="countdown px"
          style={{
            color: countdownText === "GO!" ? "#4ade9c" : "#e8ebff",
          }}
        >
          {countdownText}
        </div>
      </div>
    );
  }

  if (
    (stage === "game" || stage === "results") &&
    localConfig &&
    startPayload
  ) {
    return (
      <div className="game">
        <OnlineHudBar code={room?.code || "ONLINE"} apiRef={apiRef} />

        <div className="main">
          <OnlineGameCanvas
            key={gameKey}
            localConfig={localConfig}
            snapshot={startPayload.snapshot}
            mapping={mapping}
            apiRef={apiRef}
            onReady={onGameReady}
          />

          <OnlineSideBoard localConfig={localConfig} />
        </div>

        <OnlineDpad apiRef={apiRef} />

        {stage === "results" && results && (
          <OnlineResults
            results={results}
            selfGlobal={selfGlobalRef.current}
            onClose={() => {
              setResults(null);
              setStage("lobby");
            }}
          />
        )}

        {!connected && (
          <div className="overlay">
            <div className="card">Reconnecting…</div>
          </div>
        )}
      </div>
    );
  }

  if (room) {
    return (
      <div className="lobby">
        <div className="card">
          <div className="room-header">
            <h1 className="title" style={{ fontSize: 18 }}>
              ROOM <span className="px">{room.code}</span>
            </h1>

            <button className="copy-link" onClick={copyLink}>
              {copied ? "Copied!" : "Copy link"}
            </button>
          </div>

          <p className="sub">
            Phase: {room.phase} · Players: {room.players.length}/
            {room.settings.maxPlayers}
          </p>

          <div className="player-list">
            {room.players.map((p) => (
              <div key={p.playerId} className="player-chip">
                <i
                  className="player-dot"
                  style={{
                    background: COLORS[p.colorId % COLORS.length],
                  }}
                />

                <span>
                  {p.name}
                  {p.isHost ? " 👑" : ""}
                  {!p.connected ? " ⚠️" : ""}
                </span>

                {p.isBot && (
                  <span className="chip-actions">
                    {isHost ? (
                      <>
                        <select
                          className="mini-select"
                          value={p.botLevel || room.settings.botDifficulty}
                          onChange={(e) =>
                            setBotLevel(p.playerId, e.target.value)
                          }
                        >
                          <option value="easy">Easy</option>
                          <option value="normal">Normal</option>
                          <option value="hard">Hard</option>
                        </select>

                        <button
                          className="mini-btn"
                          onClick={() => removeSpecificBot(p.playerId)}
                        >
                          ✕
                        </button>
                      </>
                    ) : (
                      <span>🤖 {p.botLevel || room.settings.botDifficulty}</span>
                    )}
                  </span>
                )}
              </div>
            ))}
          </div>

          <div className="section-label">Bot presets</div>

          <div className="presets">
            <button
              disabled={!isHost}
              onClick={() => presetBots(1)}
            >
              Solo vs 1 Bot
            </button>

            <button
              disabled={!isHost}
              onClick={() => presetBots(2)}
            >
              vs 2 Bots
            </button>

            <button
              disabled={!isHost}
              onClick={() => presetBots(3)}
            >
              vs 3 Bots
            </button>

            <button
              disabled={!isHost}
              onClick={() => presetBots(5)}
            >
              Full Arena
            </button>
          </div>

          <div className="section-label">Room settings</div>

          <div className="settings-grid">
            <div className="setting">
              <label>Max players</label>
              <select
                value={room.settings.maxPlayers}
                disabled={!isHost}
                onChange={(e) =>
                  updateSettings({
                    maxPlayers: Number(e.target.value),
                  })
                }
              >
                {[2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>

            <div className="setting">
              <label>Duration</label>
              <select
                value={room.settings.durationS}
                disabled={!isHost}
                onChange={(e) =>
                  updateSettings({
                    durationS: Number(e.target.value) as any,
                  })
                }
              >
                {[60, 90, 120].map((n) => (
                  <option key={n} value={n}>
                    {n}s
                  </option>
                ))}
              </select>
            </div>

            <div className="setting">
              <label>Board size</label>
              <select
                value={room.settings.size}
                disabled={!isHost}
                onChange={(e) =>
                  updateSettings({
                    size: Number(e.target.value) as any,
                  })
                }
              >
                {[30, 40, 50].map((n) => (
                  <option key={n} value={n}>
                    {n}×{n}
                  </option>
                ))}
              </select>
            </div>

            <div className="setting">
              <label>Bot difficulty</label>
              <select
                value={room.settings.botDifficulty}
                disabled={!isHost}
                onChange={(e) =>
                  updateSettings({
                    botDifficulty: e.target.value as any,
                  })
                }
              >
                <option value="easy">Easy</option>
                <option value="normal">Normal</option>
                <option value="hard">Hard</option>
              </select>
            </div>

            <div className="setting setting-check">
              <input
                type="checkbox"
                checked={room.settings.sprint}
                disabled={!isHost}
                onChange={(e) =>
                  updateSettings({ sprint: e.target.checked })
                }
              />
              Sprint
            </div>

            <div className="setting setting-check">
              <input
                type="checkbox"
                checked={room.settings.powerups}
                disabled={!isHost}
                onChange={(e) =>
                  updateSettings({ powerups: e.target.checked })
                }
              />
              Power-ups
            </div>

            <div className="setting setting-check">
              <input
                type="checkbox"
                checked={room.settings.isPublic}
                disabled={!isHost}
                onChange={(e) =>
                  updateSettings({ isPublic: e.target.checked })
                }
              />
              Public
            </div>

            <div className="setting setting-check">
              <input
                type="checkbox"
                checked={room.settings.fillWithBots}
                disabled={!isHost}
                onChange={(e) =>
                  updateSettings({ fillWithBots: e.target.checked })
                }
              />
              Fill with bots
            </div>
          </div>

          <div className="row-actions">
            {isHost && (
              <>
                <button className="btn ghost" onClick={addBot}>
                  Add bot
                </button>

                <button className="btn ghost" onClick={removeBot}>
                  Remove bot
                </button>

                <button
                  className="btn"
                  onClick={startGame}
                  disabled={
                    room.players.length < 2 || room.phase !== "LOBBY"
                  }
                >
                  Start
                </button>
              </>
            )}

            <button className="btn ghost" onClick={doLeave}>
              Leave
            </button>
          </div>

          {!connected && (
            <p className="error-text">Socket disconnected. Reconnecting…</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="lobby">
      <div className="card">
        <h1 className="title">
          PIXEL
          <br />
          TURF
        </h1>

        <p className="sub">Online lobby</p>

        <label className="label">Your name</label>
        <input
          className="input"
          maxLength={12}
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

        {error && <p className="error-text">{error}</p>}

        <div className="row-actions">
          <button className="btn" onClick={doQuickPlay}>
            Quick Play
          </button>
        </div>

        <div className="row-actions">
          <button className="btn ghost" onClick={doCreate}>
            Create room
          </button>
        </div>

        <label className="label">Join with code</label>
        <input
          className="input"
          value={joinCode}
          placeholder="ABC-123"
          autoComplete="off"
          onChange={(e) => setJoinCode(e.target.value)}
        />

        <div className="row-actions">
          <button className="btn ghost" onClick={doJoin}>
            Join room
          </button>
        </div>

        <a className="btn ghost" href="/">
          Back
        </a>
      </div>
    </div>
  );
}

/* ---------------- helpers ---------------- */

function buildMapping(total: number, self: number): number[] {
  const map = new Array(total).fill(0);

  let next = 1;

  map[self] = 0;

  for (let i = 0; i < total; i++) {
    if (i === self) continue;
    map[i] = next++;
  }

  return map;
}

function buildLocalConfig(config: GameConfig, self: number): GameConfig {
  const slots = [
    config.slots[self],
    ...config.slots.filter((_, i) => i !== self),
  ];

  return {
    ...config,
    slots,
  };
}

function dirFromDxDy(dx: number, dy: number): 0 | 1 | 2 | 3 {
  if (dx === 1) return 1;
  if (dx === -1) return 3;
  if (dy === 1) return 2;
  return 0;
}

/* ---------------- HUD ---------------- */

function OnlineHudBar({
  code,
  apiRef,
}: {
  code: string;
  apiRef: MutableRefObject<LocalGameApi | null>;
}) {
  const time = useHudStore((s) => s.time);
  const duration = useHudStore((s) => s.duration);
  const low = useHudStore((s) => s.low);
  const muted = useHudStore((s) => s.muted);

  return (
    <div className="hud">
      <span className="px room-label">{code}</span>

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
        <span>online</span>
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
        {muted ? "🔇" : "🔊"}
      </button>

      <button
        className="icon-btn"
        onClick={() => apiRef.current?.toggleCamera()}
        title="Camera (V)"
      >
        🎥
      </button>
    </div>
  );
}

function OnlineSideBoard({ localConfig }: { localConfig: GameConfig }) {
  const rows = useHudStore((s) => s.leaderboard);
  const byIndex = new Map(rows.map((r) => [r.i, r]));
  const rh = useRowHeight();

  return (
    <div className="side">
      <h3>TERRITORY</h3>

      <div className="lb" style={{ height: localConfig.slots.length * rh }}>
        {localConfig.slots.map((slot, i) => {
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

function OnlineDpad({
  apiRef,
}: {
  apiRef: MutableRefObject<LocalGameApi | null>;
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
        ▲
      </button>
      <span />

      <button
        onPointerDown={(e) => {
          e.preventDefault();
          steer(-1, 0);
        }}
      >
        ◀
      </button>
      <span />
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          steer(1, 0);
        }}
      >
        ▶
      </button>

      <span />
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          steer(0, 1);
        }}
      >
        ▼
      </button>
      <span />
    </div>
  );
}

function OnlineResults({
  results,
  selfGlobal,
  onClose,
}: {
  results: GameEndPayload;
  selfGlobal: number;
  onClose: () => void;
}) {
  const winner = results.results[0];

  return (
    <div className="overlay results-overlay">
      <div className="card results-card">
        <h1 className="title results-title">
          {winner.idx === selfGlobal
            ? "YOU WIN!"
            : `${winner.name.toUpperCase()} WINS`}
        </h1>

        <p className="sub">Server-authoritative round complete.</p>

        <div>
          {results.results.map((row, idx) => (
            <div
              key={row.idx}
              className="result-row"
              style={{
                animationDelay: `${300 + idx * 150}ms`,
              }}
            >
              <span className="rk">{idx + 1}</span>

              <i
                className="sw"
                style={{
                  background: COLORS[row.idx % COLORS.length],
                }}
              />

              <span className="nm">
                {row.name}
                {row.idx === selfGlobal ? " (you)" : ""}
              </span>

              <span className="pc">{row.pct.toFixed(1)}%</span>
            </div>
          ))}
        </div>

        <button className="btn" onClick={onClose}>
          Back to lobby
        </button>
      </div>
    </div>
  );
}
