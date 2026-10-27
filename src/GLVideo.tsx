import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject, type VideoHTMLAttributes, type WheelEvent } from "react";
import { clampFov, loadLut, VideoRenderer, type Lut3D, type View360 } from "./gl";

type Props = {
  src: string | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** IDs de la LUT de conversión y del filtro; null = sin ellos. */
  lut: string | null;
  look: string | null;
  /** Intensidad del filtro (0–1). */
  lookAmount?: number;
  /** Video 360: la vista. Con `onView`, se cambia arrastrando y con la rueda. */
  view?: View360 | null;
  onView?: (view: View360) => void;
  videoProps?: VideoHTMLAttributes<HTMLVideoElement>;
  children?: ReactNode;
  className?: string;
};

/** Las LUT pedidas, ya leídas (null mientras cargan o si no hay). */
function useLuts(lut: string | null, look: string | null): [Lut3D | null, Lut3D | null] {
  const [loaded, setLoaded] = useState<Record<string, Lut3D>>({});
  useEffect(() => {
    for (const id of [lut, look]) {
      if (id && !loaded[id]) loadLut(id).then((l) => setLoaded((prev) => ({ ...prev, [id]: l }))).catch(() => {});
    }
  }, [lut, look, loaded]);
  return [lut ? (loaded[lut] ?? null) : null, look ? (loaded[look] ?? null) : null];
}

/**
 * Un video que se ve a través de la GPU: con la LUT y el filtro aplicados y,
 * si es 360, desde la vista elegida. El `<video>` sigue debajo (da el sonido
 * y los cuadros); si WebGL no está disponible, se ve él directamente.
 */
export function GLVideo({ src, videoRef, lut, look, lookAmount = 1, view, onView, videoProps, children, className = "" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // El video propio; `videoRef` es el que comparte con quien lo controla.
  const own = useRef<HTMLVideoElement | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const renderer = useRef<VideoRenderer | null>(null);
  const [failed, setFailed] = useState(() => !VideoRenderer.supported());
  // Sube si el navegador le quitó el contexto al lienzo y lo devolvió.
  const [generation, setGeneration] = useState(0);
  const [lutData, lookData] = useLuts(lut, look);
  const needsGl = !!view || !!lut || !!look;
  const active = needsGl && !failed;
  // Al cambiar de archivo con una animación, el video anterior sale después
  // de que entra el nuevo: no debe borrar la referencia. Estable, para que
  // React no lo desprenda (y lo pause) en cada render.
  const attachVideo = useCallback(
    (el: HTMLVideoElement | null) => {
      own.current = el;
      if (!el) return;
      videoRef.current = el;
      return () => {
        el.pause();
        if (videoRef.current === el) videoRef.current = null;
        if (own.current === el) own.current = null;
      };
    },
    [videoRef],
  );
  const viewRef = useRef(view ?? null);
  viewRef.current = view ?? null;
  const amountRef = useRef(lookAmount);
  amountRef.current = lookAmount;

  const draw = () => {
    const r = renderer.current;
    const v = own.current;
    if (!r || !v || v.readyState < 2) return;
    r.view = viewRef.current;
    r.lookAmount = amountRef.current;
    if (!r.draw(v) && v.videoWidth) setFailed(true);
  };

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!active || !canvas) return;
    try {
      renderer.current = new VideoRenderer(canvas);
    } catch {
      setFailed(true);
      return;
    }
    // Si el navegador suelta el contexto (demasiados abiertos, la GPU se
    // reinició…), se pide que lo devuelva y se rehace el renderizador.
    const lost = (e: Event) => {
      e.preventDefault();
      renderer.current = null;
    };
    const restored = () => setGeneration((g) => g + 1);
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    return () => {
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, [active, generation]);

  // El lienzo a la resolución real de la pantalla.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas) return;
    const observer = new ResizeObserver(([entry]) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(entry.contentRect.width * dpr));
      canvas.height = Math.max(1, Math.round(entry.contentRect.height * dpr));
      draw();
    });
    observer.observe(box);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    renderer.current?.setLut(0, lutData);
    renderer.current?.setLut(1, lookData);
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lutData, lookData, active, generation]);

  useEffect(draw, [view, lookAmount]); // eslint-disable-line react-hooks/exhaustive-deps

  // Un cuadro nuevo en cada cuadro del video (o en cada pantalla, si el
  // navegador no avisa por cuadro).
  useEffect(() => {
    const v = own.current;
    if (!active || !v) return;
    let stop = false;
    let handle = 0;
    const frameCallback = "requestVideoFrameCallback" in v;
    const loop = () => {
      if (stop) return;
      draw();
      handle = frameCallback ? v.requestVideoFrameCallback(loop) : requestAnimationFrame(loop);
    };
    loop();
    const once = () => draw();
    v.addEventListener("loadeddata", once);
    v.addEventListener("seeked", once);
    return () => {
      stop = true;
      if (frameCallback) v.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
      v.removeEventListener("loadeddata", once);
      v.removeEventListener("seeked", once);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, src, generation]);

  // 360: arrastrar mira alrededor (como mover la cámara) y la rueda acerca.
  const drag = useRef<{ x: number; y: number; view: View360; moved: boolean } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!view || !onView) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, view, moved: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !onView) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    const width = e.currentTarget.clientWidth || 1;
    const perPixel = (d.view.mode === "planet" ? 180 : d.view.fov) / width;
    const yaw = (((d.view.yaw - dx * perPixel + 180) % 360) + 360) % 360 - 180;
    const pitch = Math.max(-90, Math.min(90, d.view.pitch + dy * perPixel * (d.view.mode === "planet" ? -1 : 1)));
    onView({ ...d.view, yaw, pitch });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    // Un arrastre no es un clic: no pausa ni reproduce el video.
    if (d?.moved) {
      const stopClick = (ev: Event) => ev.stopPropagation();
      e.currentTarget.addEventListener("click", stopClick, { capture: true, once: true });
      setTimeout(() => e.currentTarget?.removeEventListener("click", stopClick, { capture: true }), 0);
    }
  };
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!view || !onView) return;
    onView({ ...view, fov: clampFov(view, view.fov * Math.exp(e.deltaY * 0.0015)) });
  };

  return (
    <div
      ref={boxRef}
      className={`glvideo ${active ? "gl-on" : ""} ${view && onView ? "draggable" : ""} ${className}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      {src && (
        <video
          ref={attachVideo}
          src={src}
          crossOrigin="anonymous"
          playsInline
          preload="auto"
          {...videoProps}
        />
      )}
      <canvas ref={canvasRef} />
      {children}
    </div>
  );
}
