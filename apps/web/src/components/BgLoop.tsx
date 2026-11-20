import { useEffect, useRef } from "react";
import { COLORS } from "@pixel-turf/shared";

export function BgLoop() {
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
