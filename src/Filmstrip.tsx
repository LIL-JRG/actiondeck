import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject, type WheelEvent } from "react";
import { motion, useMotionValue } from "motion/react";
import { formatClock } from "./format";

/** Lo que se conserva de un clip, con sus bordes arrastrables en la tira. */
export type TrimRange = { inPoint: number; outPoint: number; onChange: (inPoint: number, outPoint: number) => void };

type Props = {
  /** El video que se está viendo: la tira lo sigue y lo mueve. */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** De dónde sacar los cuadros (puede ser la versión ligera). */
  src: string | null;
  duration: number;
  trim?: TrimRange;
  height?: number;
};

const MIN_TRIM = 0.2;

/**
 * Tira de cuadros como la de Mimo: el cabezal queda fijo al centro y la tira
 * corre debajo. Se arrastra (o se usa la rueda) para buscar; con `trim`, los
 * bordes amarillos marcan el inicio y el fin del recorte.
 */
export function Filmstrip({ videoRef, src, duration, trim, height = 56 }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  const x = useMotionValue(0);
  const gesture = useRef<{ startX: number; startT: number; moved: boolean; wasPlaying: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Un clip corto cabe en media tira (se ven sus dos bordes al inicio o al
  // final); uno largo ocupa hasta cuatro anchos de pantalla.
  const safeDuration = Math.max(duration, 0.1);
  const stripWidth = width ? Math.min(Math.max(safeDuration * 30, width * 0.46), width * 4) : 0;
  const pxPerSec = stripWidth / safeDuration;
  const frameWidth = Math.round((height * 16) / 9);
  const frameCount = stripWidth ? Math.ceil(stripWidth / frameWidth) : 0;

  const place = (t: number) => {
    x.set(width / 2 - t * pxPerSec);
    if (clockRef.current) clockRef.current.textContent = formatClock(t);
  };

  // Sigue al video cuadro por cuadro (timeupdate solo llega unas 4 veces por segundo).
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v && !gesture.current) place(v.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // place depende del ancho y la escala; se recrea con ellos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef, width, pxPerSec]);

  const seek = (t: number) => {
    const v = videoRef.current;
    const clamped = Math.min(Math.max(t, 0), duration);
    if (v) v.currentTime = clamped;
    place(clamped);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const v = videoRef.current;
    e.currentTarget.setPointerCapture(e.pointerId);
    const wasPlaying = !!v && !v.paused;
    v?.pause();
    gesture.current = { startX: e.clientX, startT: v?.currentTime ?? 0, moved: false, wasPlaying };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || !pxPerSec) return;
    const dx = e.clientX - g.startX;
    if (Math.abs(dx) > 3) g.moved = true;
    if (g.moved) seek(g.startT - dx / pxPerSec);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    // Un clic sin arrastrar lleva el cabezal a ese punto.
    if (!g.moved && pxPerSec) {
      const rect = e.currentTarget.getBoundingClientRect();
      seek(g.startT + (e.clientX - rect.left - width / 2) / pxPerSec);
    }
    if (g.wasPlaying) videoRef.current?.play().catch(() => {});
  };

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const v = videoRef.current;
    if (!v || !pxPerSec) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    seek(v.currentTime + delta / pxPerSec);
  };

  return (
    <div className="filmstrip-wrap">
      <div className="clock">
        <span ref={clockRef}>00:00</span>
        <span className="clock-total"> / {formatClock(duration)}</span>
      </div>
      <div
        ref={boxRef}
        className="filmstrip"
        style={{ height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <motion.div className="filmstrip-track" style={{ x, width: stripWidth, height }}>
          <Frames src={src} duration={duration} count={frameCount} frameWidth={frameWidth} height={height} />
          {trim && <TrimHandles trim={trim} duration={duration} pxPerSec={pxPerSec} onSeek={seek} />}
        </motion.div>
        <div className="playhead" />
      </div>
    </div>
  );
}

/** Cuadros sacados del propio video con un reproductor oculto, de uno en uno. */
function Frames({
  src,
  duration,
  count,
  frameWidth,
  height,
}: {
  src: string | null;
  duration: number;
  count: number;
  frameWidth: number;
  height: number;
}) {
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);

  useEffect(() => {
    if (!src || !count || !duration) return;
    let cancelled = false;
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    video.src = src;

    const once = (event: string, ms: number) =>
      new Promise<boolean>((resolve) => {
        const timer = window.setTimeout(() => resolve(false), ms);
        video.addEventListener(
          event,
          () => {
            window.clearTimeout(timer);
            resolve(true);
          },
          { once: true },
        );
      });

    (async () => {
      if (!(await once("loadeddata", 15000)) || cancelled) return;
      const dpr = window.devicePixelRatio || 1;
      for (let i = 0; i < count; i++) {
        if (cancelled) return;
        const canvas = canvases.current[i];
        if (!canvas) continue;
        video.currentTime = Math.min(duration - 0.05, ((i + 0.5) * duration) / count);
        if (!(await once("seeked", 6000)) || cancelled) continue;
        canvas.width = frameWidth * dpr;
        canvas.height = height * dpr;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        // Como object-fit: cover.
        const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
        const w = video.videoWidth * scale;
        const h = video.videoHeight * scale;
        ctx.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        canvas.classList.add("ready");
      }
    })();

    return () => {
      cancelled = true;
      video.removeAttribute("src");
      video.load();
    };
  }, [src, duration, count, frameWidth, height]);

  return (
    <div className="frames">
      {Array.from({ length: count }, (_, i) => (
        <canvas
          key={`${src}-${count}-${i}`}
          ref={(el) => {
            canvases.current[i] = el;
          }}
          style={{ width: frameWidth, height }}
        />
      ))}
    </div>
  );
}

function TrimHandles({
  trim,
  duration,
  pxPerSec,
  onSeek,
}: {
  trim: TrimRange;
  duration: number;
  pxPerSec: number;
  onSeek: (t: number) => void;
}) {
  const drag = useRef<{ edge: "in" | "out"; startX: number; start: number } | null>(null);
  const left = trim.inPoint * pxPerSec;
  const right = trim.outPoint * pxPerSec;

  const down = (edge: "in" | "out") => (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { edge, startX: e.clientX, start: edge === "in" ? trim.inPoint : trim.outPoint };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !pxPerSec) return;
    e.stopPropagation();
    const t = d.start + (e.clientX - d.startX) / pxPerSec;
    if (d.edge === "in") {
      const inPoint = Math.min(Math.max(0, t), trim.outPoint - MIN_TRIM);
      trim.onChange(inPoint, trim.outPoint);
      onSeek(inPoint);
    } else {
      const outPoint = Math.max(Math.min(duration, t), trim.inPoint + MIN_TRIM);
      trim.onChange(trim.inPoint, outPoint);
      onSeek(outPoint);
    }
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    drag.current = null;
  };

  return (
    <>
      <div className="trim-shade" style={{ left: 0, width: left }} />
      <div className="trim-shade" style={{ left: right, right: 0 }} />
      <div className="trim-window" style={{ left, width: right - left }}>
        <div
          className="trim-handle in"
          onPointerDown={down("in")}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          aria-label="Inicio del recorte"
        />
        <div
          className="trim-handle out"
          onPointerDown={down("out")}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          aria-label="Fin del recorte"
        />
      </div>
    </>
  );
}
