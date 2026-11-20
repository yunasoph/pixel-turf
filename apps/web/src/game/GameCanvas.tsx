import { useEffect, useRef, type MutableRefObject } from "react";
import type { GameConfig } from "@pixel-turf/shared";
import { LocalGame, type LocalGameApi } from "./LocalGame";
import { useHudStore } from "./hudStore";

interface GameCanvasProps {
  config: GameConfig;
  apiRef: MutableRefObject<LocalGameApi | null>;
}

export function GameCanvas({ config, apiRef }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    const game = new LocalGame(
      canvasRef.current,
      minimapRef.current,
      config
    );

    apiRef.current = game;
    game.start();

    return () => {
      game.dispose();
      apiRef.current = null;
    };
  }, [config, apiRef]);

  return (
    <div className="wrap">
      <canvas ref={canvasRef} className="cv" />
      <canvas ref={minimapRef} className="mm" width={140} height={140} />
      <Toast />
      <SprintPill apiRef={apiRef} />
    </div>
  );
}

function Toast() {
  const toast = useHudStore((s) => s.toast);

  if (!toast) return null;

  return (
    <div
      key={toast.id}
      className="toast show"
      style={{
        borderColor: toast.color,
        boxShadow: `0 0 24px ${toast.color}55`,
      }}
    >
      {toast.text}
    </div>
  );
}

function SprintPill({
  apiRef,
}: {
  apiRef: MutableRefObject<LocalGameApi | null>;
}) {
  const sprint = useHudStore((s) => s.sprint);

  const label =
    sprint.mode === "ready"
      ? "SPRINT"
      : sprint.mode === "running"
      ? "RUNNING"
      : "RECHARGING";

  const shield =
    sprint.shield > 0 ? `  ðŸ›¡${Math.ceil(sprint.shield)}` : "";

  return (
    <div
      className={`sprint ${sprint.mode}`}
      onPointerDown={(e) => {
        e.preventDefault();
        apiRef.current?.sprint();
      }}
    >
      <div className="sprint-top">
        <span className="sprint-label">
          {label}
          {shield ? <span className="emoji">{shield}</span> : null}
        </span>
        <kbd>SPACE</kbd>
      </div>
      <div className="sprint-bar">
        <b style={{ width: `${sprint.progress * 100}%` }} />
      </div>
    </div>
  );
}
