import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  api,
  errorText,
  fileUrl,
  hardwareName,
  joinPath,
  onExportProgress,
  type ClipInfo,
  type Codec,
  type Encoder,
  type ExportProgress,
  type Fit,
  type MediaFile,
  type Settings,
  type TimelineItem,
} from "./api";
import { describeClip, formatTime } from "./format";

type Props = {
  settings: Settings;
  library: MediaFile[];
  timeline: TimelineItem[];
  setTimeline: (update: (prev: TimelineItem[]) => TimelineItem[]) => void;
  onError: (message: string) => void;
};

type Draft = {
  path: string;
  name: string;
  info: ClipInfo;
  inPoint: number;
  outPoint: number;
  applyLut: boolean;
  speed: number;
  volume: number;
  cropX: number;
  cropY: number;
  editingId: string | null;
};

/** Formato del video final; "source" = el del primer clip. */
export type FrameFormat = "source" | "16:9" | "9:16" | "1:1" | "4:5";

const FORMATS: { id: FrameFormat; label: string; ratio: number | null }[] = [
  { id: "source", label: "Original", ratio: null },
  { id: "16:9", label: "16:9 horizontal", ratio: 16 / 9 },
  { id: "9:16", label: "9:16 vertical", ratio: 9 / 16 },
  { id: "1:1", label: "1:1 cuadrado", ratio: 1 },
  { id: "4:5", label: "4:5 retrato", ratio: 4 / 5 },
];

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4];

function clipRatio(info: ClipInfo): number {
  return info.width / info.height;
}

/** Duración en el video final, con la velocidad aplicada. */
function outputDuration(item: { inPoint: number; outPoint: number; speed: number }): number {
  return (item.outPoint - item.inPoint) / item.speed;
}

function formatSpeed(speed: number): string {
  return `${speed}×`;
}

export function EditView({ settings, library, timeline, setTimeline, onError }: Props) {
  const videos = useMemo(() => library.filter((f) => f.kind === "video"), [library]);
  const [infos, setInfos] = useState<Record<string, ClipInfo | string>>({});
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  // Formato y encuadre son del proyecto: los usa el marco de recorte de cada
  // clip y la exportación.
  const [format, setFormat] = useState<FrameFormat>("source");
  const [fit, setFit] = useState<Fit>("crop");
  const hasLut = settings.lutName !== null;

  const firstInfo = timeline[0]?.info ?? draft?.info;
  const targetRatio = FORMATS.find((f) => f.id === format)?.ratio ?? (firstInfo ? clipRatio(firstInfo) : null);

  // Analiza los clips y genera miniaturas de uno en uno para no saturar el disco.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const file of videos) {
        if (cancelled) return;
        if (!(file.path in infos)) {
          try {
            const info = await api.probe(file.path);
            if (!cancelled) setInfos((prev) => ({ ...prev, [file.path]: info }));
          } catch (e) {
            if (!cancelled) setInfos((prev) => ({ ...prev, [file.path]: errorText(e) }));
            continue;
          }
        }
        if (!(file.path in thumbs)) {
          try {
            const thumb = await api.thumbnail(file.path);
            if (!cancelled) setThumbs((prev) => ({ ...prev, [file.path]: thumb }));
          } catch {
            // Sin miniatura el clip sigue siendo usable.
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Solo debe reaccionar a cambios de la biblioteca.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos]);

  const openClip = (file: MediaFile) => {
    const info = infos[file.path];
    if (!info || typeof info === "string") return;
    setDraft({
      path: file.path,
      name: file.name,
      info,
      inPoint: 0,
      outPoint: info.duration,
      applyLut: hasLut,
      speed: 1,
      volume: 1,
      cropX: 0.5,
      cropY: 0.5,
      editingId: null,
    });
  };

  const editItem = (item: TimelineItem) => setDraft({ ...item, editingId: item.id });

  const itemFrom = (d: Draft, id: string): TimelineItem => ({
    id,
    path: d.path,
    name: d.name,
    inPoint: d.inPoint,
    outPoint: d.outPoint,
    applyLut: d.applyLut && hasLut,
    hasAudio: d.info.hasAudio,
    speed: d.speed,
    volume: d.volume,
    cropX: d.cropX,
    cropY: d.cropY,
    info: d.info,
  });

  const commitDraft = () => {
    if (!draft) return;
    const item = itemFrom(draft, draft.editingId ?? crypto.randomUUID());
    setTimeline((prev) => (draft.editingId ? prev.map((t) => (t.id === draft.editingId ? item : t)) : [...prev, item]));
    setDraft({ ...draft, editingId: item.id });
  };

  /** Parte el clip de la línea de tiempo en dos en `at`, con sus ajustes actuales. */
  const splitAt = (at: number) => {
    if (!draft?.editingId) return;
    const first = itemFrom({ ...draft, outPoint: at }, draft.editingId);
    const second = itemFrom({ ...draft, inPoint: at }, crypto.randomUUID());
    setTimeline((prev) => prev.flatMap((t) => (t.id === draft.editingId ? [first, second] : [t])));
    setDraft({ ...draft, inPoint: at, editingId: second.id });
  };

  return (
    <div className="edit-view">
      <aside className="panel library">
        <h2>Biblioteca</h2>
        {videos.length === 0 && <p className="hint">Importa videos en la pestaña Importar.</p>}
        <ul className="clip-list">
          {videos.map((file) => {
            const info = infos[file.path];
            return (
              <li key={file.path}>
                <button
                  className={draft?.path === file.path ? "clip active" : "clip"}
                  onClick={() => openClip(file)}
                  disabled={!info || typeof info === "string"}
                  title={typeof info === "string" ? info : file.path}
                >
                  <div className="thumb">{thumbs[file.path] && <img src={fileUrl(thumbs[file.path])} alt="" />}</div>
                  <div className="clip-text">
                    <span className="clip-name">{file.name}</span>
                    <span className="clip-meta">
                      {!info
                        ? "Analizando…"
                        : typeof info === "string"
                          ? "No se pudo leer"
                          : `${formatTime(info.duration)} · ${info.width}×${info.height} · ${info.bitDepth}-bit`}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <section className="panel stage">
        <div className="stage-scroll">
          {draft ? (
            <ClipEditor
              key={draft.path}
              draft={draft}
              setDraft={setDraft}
              hasLut={hasLut}
              cropRatio={fit === "crop" ? targetRatio : null}
              onCommit={commitDraft}
              onSplit={splitAt}
              onError={onError}
            />
          ) : (
            <div className="empty-stage">
              <p>Elige un clip de la biblioteca para verlo, recortarlo y agregarlo a la línea de tiempo.</p>
            </div>
          )}
        </div>
        <Timeline items={timeline} setItems={setTimeline} activeId={draft?.editingId ?? null} onEdit={editItem} />
      </section>

      <aside className="panel export">
        <ExportPanel
          settings={settings}
          timeline={timeline}
          format={format}
          setFormat={setFormat}
          fit={fit}
          setFit={setFit}
          onError={onError}
        />
      </aside>
    </div>
  );
}

/** Tamaño de un elemento, actualizado al cambiar la ventana. */
function useSize<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

/**
 * Marco del formato de salida sobre el video. Lo de fuera se oscurece y se
 * arrastra desde el asa del centro para elegir qué parte de la imagen queda.
 */
function CropFrame({
  sourceRatio,
  targetRatio,
  x,
  y,
  onMove,
}: {
  sourceRatio: number;
  targetRatio: number;
  x: number;
  y: number;
  onMove: (x: number, y: number) => void;
}) {
  // Fracción del video que ocupa el marco.
  const w = Math.min(1, targetRatio / sourceRatio);
  const h = Math.min(1, sourceRatio / targetRatio);
  const left = (1 - w) * x;
  const top = (1 - h) * y;
  const drag = useRef<{ startX: number; startY: number; x: number; y: number; box: DOMRect } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    const box = e.currentTarget.parentElement?.parentElement?.getBoundingClientRect();
    if (!box) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, x, y, box };
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    const nx = w < 1 ? clamp(d.x + (e.clientX - d.startX) / (d.box.width * (1 - w))) : x;
    const ny = h < 1 ? clamp(d.y + (e.clientY - d.startY) / (d.box.height * (1 - h))) : y;
    onMove(nx, ny);
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const pct = (v: number) => `${v * 100}%`;
  return (
    <div className="crop-overlay">
      <div className="crop-shade" style={{ left: 0, top: 0, width: pct(left), height: "100%" }} />
      <div className="crop-shade" style={{ left: pct(left + w), top: 0, right: 0, height: "100%" }} />
      <div className="crop-shade" style={{ left: pct(left), top: 0, width: pct(w), height: pct(top) }} />
      <div className="crop-shade" style={{ left: pct(left), top: pct(top + h), width: pct(w), bottom: 0 }} />
      <div className="crop-box" style={{ left: pct(left), top: pct(top), width: pct(w), height: pct(h) }}>
        <button
          className="crop-grip"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          aria-label="Mover el encuadre"
          title="Arrastra para elegir qué parte de la imagen queda"
        >
          Mover
        </button>
      </div>
    </div>
  );
}

function ClipEditor({
  draft,
  setDraft,
  hasLut,
  cropRatio,
  onCommit,
  onSplit,
  onError,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  hasLut: boolean;
  /** Formato al que se recorta el video final, o null si no se recorta. */
  cropRatio: number | null;
  onCommit: () => void;
  onSplit: (at: number) => void;
  onError: (message: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);
  const [frames, setFrames] = useState<{ before: string; after: string | null; stamp: number } | null>(null);
  const [comparing, setComparing] = useState(false);
  const [forceProxy, setForceProxy] = useState(false);
  const [playerRef, playerSize] = useSize<HTMLDivElement>();

  useEffect(() => {
    let alive = true;
    setPreview(null);
    api
      .previewSource(draft.path, forceProxy)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setPreviewError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [draft.path, forceProxy]);

  // La vista previa reproduce con la velocidad y el volumen elegidos. El
  // reproductor no sube de 100 %: arriba de eso solo se nota al exportar.
  const applyPlayback = () => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = draft.speed;
    v.volume = Math.min(1, draft.volume);
    v.muted = draft.volume === 0;
  };
  useEffect(applyPlayback, [draft.speed, draft.volume, preview]);

  // Si el visor no logra reproducir el original (p. ej. un HEVC que este
  // sistema no admite), se pide la copia ligera una sola vez.
  const onVideoError = () => {
    if (!forceProxy) setForceProxy(true);
    else setPreviewError("No se pudo reproducir la vista previa.");
  };

  const seek = (t: number) => {
    if (videoRef.current) videoRef.current.currentTime = t;
    setCurrent(t);
  };

  const setIn = (t: number) => setDraft({ ...draft, inPoint: Math.min(Math.max(0, t), draft.outPoint - 0.1) });
  const setOut = (t: number) => setDraft({ ...draft, outPoint: Math.max(Math.min(draft.info.duration, t), draft.inPoint + 0.1) });

  // Al reproducir dentro del recorte, se detiene en el punto final.
  const onTime = () => {
    const v = videoRef.current;
    if (!v) return;
    setCurrent(v.currentTime);
    if (!v.paused && v.currentTime >= draft.outPoint) {
      v.pause();
      v.currentTime = draft.outPoint;
    }
  };

  const playRange = () => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = draft.inPoint;
    applyPlayback();
    v.play();
  };

  const compare = async () => {
    setComparing(true);
    try {
      const pair = await api.compareFrames(draft.path, current);
      setFrames({ ...pair, stamp: Date.now() });
    } catch (e) {
      onError(errorText(e));
    } finally {
      setComparing(false);
    }
  };

  const sourceRatio = clipRatio(draft.info);
  // El video ocupa lo más que puede del reproductor sin deformarse.
  const frameSize = (() => {
    const { width, height } = playerSize;
    if (!width || !height) return null;
    return width / height > sourceRatio
      ? { width: height * sourceRatio, height }
      : { width, height: width / sourceRatio };
  })();
  const showCrop = cropRatio !== null && Math.abs(cropRatio - sourceRatio) > 0.01;

  const inPct = (draft.inPoint / draft.info.duration) * 100;
  const outPct = (draft.outPoint / draft.info.duration) * 100;
  const length = draft.outPoint - draft.inPoint;
  const canSplit = draft.editingId !== null && current > draft.inPoint + 0.2 && current < draft.outPoint - 0.2;
  const slowMotionNote =
    draft.speed < 1
      ? draft.info.fps * draft.speed >= 24
        ? `Cámara lenta fluida: se grabó a ${Math.round(draft.info.fps)} fps.`
        : `Se verá entrecortado: se grabó a ${Math.round(draft.info.fps)} fps. Para cámara lenta fluida, graba a 100 o 120 fps.`
      : null;

  return (
    <div className="clip-editor">
      <header className="stage-header">
        <div>
          <h2>{draft.name}</h2>
          <p className="hint small">{describeClip(draft.info)}</p>
        </div>
        {(!draft.info.browserPlayable || forceProxy) && preview && <span className="badge">Vista previa ligera</span>}
      </header>

      <div className="player" ref={playerRef}>
        {preview && frameSize ? (
          <div className="frame" style={{ width: frameSize.width, height: frameSize.height }}>
            <video
              ref={videoRef}
              src={fileUrl(preview)}
              controls
              onTimeUpdate={onTime}
              onSeeked={onTime}
              onLoadedMetadata={applyPlayback}
              onError={onVideoError}
              preload="auto"
            />
            {showCrop && (
              <CropFrame
                sourceRatio={sourceRatio}
                targetRatio={cropRatio}
                x={draft.cropX}
                y={draft.cropY}
                onMove={(cropX, cropY) => setDraft({ ...draft, cropX, cropY })}
              />
            )}
          </div>
        ) : (
          <div className="player-placeholder">
            {previewError ?? (draft.info.browserPlayable && !forceProxy ? "Cargando…" : "Preparando vista previa ligera…")}
          </div>
        )}
      </div>

      <div
        className="trim-bar"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          seek(((e.clientX - rect.left) / rect.width) * draft.info.duration);
        }}
      >
        <div className="trim-range" style={{ left: `${inPct}%`, width: `${outPct - inPct}%` }} />
        <div className="trim-head" style={{ left: `${(current / draft.info.duration) * 100}%` }} />
      </div>

      <div className="trim-controls">
        <label>
          Inicio
          <input type="number" step={0.1} min={0} value={draft.inPoint.toFixed(1)} onChange={(e) => setIn(Number(e.target.value))} />
        </label>
        <button className="secondary" onClick={() => setIn(current)}>Marcar inicio</button>
        <button className="secondary" onClick={playRange}>Reproducir recorte</button>
        <button className="secondary" onClick={() => setOut(current)}>Marcar fin</button>
        <label>
          Fin
          <input type="number" step={0.1} min={0} value={draft.outPoint.toFixed(1)} onChange={(e) => setOut(Number(e.target.value))} />
        </label>
        <button
          className="secondary"
          onClick={() => onSplit(current)}
          disabled={!canSplit}
          title={draft.editingId ? "Parte este clip en dos en la posición actual" : "Agrega el clip a la línea de tiempo para poder dividirlo"}
        >
          Dividir en {formatTime(current)}
        </button>
      </div>

      <div className="adjust-grid">
        <div className="adjust">
          <span className="adjust-label">Velocidad</span>
          <div className="segmented" role="group" aria-label="Velocidad">
            {SPEEDS.map((s) => (
              <button
                key={s}
                className={draft.speed === s ? "active" : ""}
                aria-pressed={draft.speed === s}
                onClick={() => setDraft({ ...draft, speed: s })}
              >
                {formatSpeed(s)}
              </button>
            ))}
          </div>
          <span className="hint small">
            Duración {formatTime(length / draft.speed)}
            {draft.speed !== 1 && ` (original ${formatTime(length)})`}
            {slowMotionNote && <> · {slowMotionNote}</>}
          </span>
        </div>

        <div className="adjust">
          <span className="adjust-label">Volumen</span>
          {draft.info.hasAudio ? (
            <div className="volume-row">
              <button className="secondary" onClick={() => setDraft({ ...draft, volume: draft.volume === 0 ? 1 : 0 })}>
                {draft.volume === 0 ? "Activar sonido" : "Silenciar"}
              </button>
              <input
                type="range"
                min={0}
                max={200}
                step={5}
                value={Math.round(draft.volume * 100)}
                onChange={(e) => setDraft({ ...draft, volume: Number(e.target.value) / 100 })}
                aria-label="Volumen"
              />
              <span className="volume-value">{Math.round(draft.volume * 100)} %</span>
            </div>
          ) : (
            <span className="hint small">Este clip no tiene sonido.</span>
          )}
        </div>
      </div>

      {showCrop && (
        <p className="hint small">
          El marco muestra lo que queda en el video final; arrástralo desde «Mover» para elegir el encuadre.
        </p>
      )}

      <div className="color-row">
        <label className={hasLut ? "toggle" : "toggle disabled"} title={hasLut ? "" : "Elige una LUT en Ajustes"}>
          <input
            type="checkbox"
            checked={draft.applyLut && hasLut}
            disabled={!hasLut}
            onChange={(e) => setDraft({ ...draft, applyLut: e.target.checked })}
          />
          Recuperar color (aplicar LUT de D-Log M)
        </label>
        <button className="secondary" onClick={compare} disabled={comparing}>
          {comparing ? "Generando…" : `Comparar en ${formatTime(current)}`}
        </button>
        <button className="primary" onClick={onCommit}>
          {draft.editingId ? "Actualizar en la línea de tiempo" : "Agregar a la línea de tiempo"}
        </button>
      </div>

      {frames && (
        <div className="compare">
          <figure>
            <img src={fileUrl(frames.before, frames.stamp)} alt="Original" />
            <figcaption>Original</figcaption>
          </figure>
          {frames.after ? (
            <figure>
              <img src={fileUrl(frames.after, frames.stamp)} alt="Con LUT" />
              <figcaption>Con LUT</figcaption>
            </figure>
          ) : (
            <p className="hint">Elige una LUT en Ajustes para ver el color corregido.</p>
          )}
        </div>
      )}
    </div>
  );
}

function Timeline({
  items,
  setItems,
  activeId,
  onEdit,
}: {
  items: TimelineItem[];
  setItems: (update: (prev: TimelineItem[]) => TimelineItem[]) => void;
  activeId: string | null;
  onEdit: (item: TimelineItem) => void;
}) {
  const total = items.reduce((sum, i) => sum + outputDuration(i), 0);
  const move = (index: number, delta: number) =>
    setItems((prev) => {
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(index + delta, 0, item);
      return next;
    });

  return (
    <div className="timeline">
      <header className="timeline-header">
        <h3>Línea de tiempo</h3>
        <span className="hint small">
          {items.length} clips · {formatTime(total)}
        </span>
      </header>
      {items.length === 0 ? (
        <p className="hint small">Los clips que agregues se unirán en este orden.</p>
      ) : (
        <ol className="timeline-items">
          {items.map((item, i) => (
            <li key={item.id} className={item.id === activeId ? "t-item active" : "t-item"}>
              <button className="t-main" onClick={() => onEdit(item)}>
                <span className="t-name">{i + 1}. {item.name}</span>
                <span className="t-meta">
                  {formatTime(item.inPoint)}–{formatTime(item.outPoint)}
                  {item.speed !== 1 && <span className="badge lut">{formatSpeed(item.speed)}</span>}
                  {item.hasAudio && item.volume === 0 && <span className="badge lut">Sin sonido</span>}
                  {item.applyLut && <span className="badge lut">LUT</span>}
                </span>
              </button>
              <div className="t-actions">
                <button className="icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Mover a la izquierda">←</button>
                <button className="icon" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Mover a la derecha">→</button>
                <button className="icon" onClick={() => setItems((prev) => prev.filter((t) => t.id !== item.id))} aria-label="Quitar">×</button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Lado corto del video final; "max" = lo más que da el clip sin agrandarlo. */
const SIZES = [
  { id: "max", label: "Máxima del clip" },
  { id: "2160", label: "4K" },
  { id: "1512", label: "2.7K" },
  { id: "1080", label: "1080p" },
  { id: "720", label: "720p" },
];
const FRAME_RATES = [24, 25, 30, 48, 50, 60, 100, 120];

function even(n: number): number {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r - 1;
}

/** Ancho y alto de salida para un formato, un encuadre y un tamaño. */
function outputSize(first: ClipInfo, ratio: number, fit: Fit, size: string): { w: number; h: number } {
  if (size === "max") {
    const src = clipRatio(first);
    // Recortar: el mayor rectángulo del formato dentro del clip. Barras: el
    // menor que contiene al clip completo. En ambos casos un lado mide lo
    // mismo que el clip; cuál, depende de si el formato es más angosto.
    const keepsHeight = (fit === "crop") === ratio < src;
    return keepsHeight
      ? { w: even(first.height * ratio), h: even(first.height) }
      : { w: even(first.width), h: even(first.width / ratio) };
  }
  const short = Number(size);
  return ratio >= 1 ? { w: even(short * ratio), h: even(short) } : { w: even(short), h: even(short / ratio) };
}

function ExportPanel({
  settings,
  timeline,
  format,
  setFormat,
  fit,
  setFit,
  onError,
}: {
  settings: Settings;
  timeline: TimelineItem[];
  format: FrameFormat;
  setFormat: (f: FrameFormat) => void;
  fit: Fit;
  setFit: (f: Fit) => void;
  onError: (m: string) => void;
}) {
  const first = timeline[0]?.info;
  const [codec, setCodec] = useState<Codec>("hevc");
  const hardware = settings.hardware;
  const [encoder, setEncoder] = useState<Encoder>(hardware?.hevc ? hardware.encoder : "cpu");
  const [quality, setQuality] = useState(20);
  const [size, setSize] = useState("max");
  const [fps, setFps] = useState("source");
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    const pending = onExportProgress(setProgress);
    return () => {
      pending.then((unlisten) => unlisten());
    };
  }, []);

  const hardwareOk = !!hardware && (codec === "h264" ? hardware.h264 : hardware.hevc);
  useEffect(() => {
    if (encoder !== "cpu" && !hardwareOk) setEncoder("cpu");
  }, [encoder, hardwareOk]);

  const chooseFormat = (next: FrameFormat) => {
    setFormat(next);
    // Para redes sociales, 1080 es lo habitual; en el formato original, lo máximo.
    setSize(next === "source" ? "max" : "1080");
  };

  const ratio = FORMATS.find((f) => f.id === format)?.ratio ?? (first ? clipRatio(first) : null);
  const reframes = !!first && ratio !== null && Math.abs(ratio - clipRatio(first)) > 0.01;
  const out = first && ratio ? outputSize(first, ratio, reframes ? fit : "crop", size) : null;
  const frameRate = fps === "source" ? (first ? Math.round(first.fps * 1000) / 1000 : 30) : Number(fps);
  const needsLut = timeline.some((t) => t.applyLut);
  const blocked = timeline.length === 0 || !out || (needsLut && !settings.lutName) || !!settings.ffmpegError;

  const run = async () => {
    if (!out) return;
    const output = await save({
      title: "Guardar video",
      defaultPath: joinPath(settings.libraryDir, "Exportados", `ActionDeck_${localStamp()}.mp4`),
      filters: [{ name: "Video MP4", extensions: ["mp4"] }],
    });
    if (!output) return;
    setExporting(true);
    setResult(null);
    setProgress(null);
    try {
      const path = await api.startExport(timeline, {
        output,
        codec,
        encoder,
        quality,
        width: out.w,
        height: out.h,
        fps: frameRate,
        fit: reframes ? fit : "crop",
      });
      setResult(path);
    } catch (e) {
      const message = errorText(e);
      if (message !== "Exportación cancelada") onError(message);
    } finally {
      setExporting(false);
    }
  };

  const percent = progress && progress.secondsTotal > 0 ? (progress.secondsDone / progress.secondsTotal) * 100 : 0;

  return (
    <div className="export-panel">
      <h2>Exportar</h2>

      <label className="field">
        Formato del video
        <select value={format} onChange={(e) => chooseFormat(e.target.value as FrameFormat)} disabled={exporting}>
          {FORMATS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.id === "source" && first ? `Original del primer clip (${first.width}×${first.height})` : f.label}
            </option>
          ))}
        </select>
      </label>

      {reframes && (
        <div className="field">
          Encuadre
          <div className="segmented" role="group" aria-label="Encuadre">
            <button className={fit === "crop" ? "active" : ""} aria-pressed={fit === "crop"} onClick={() => setFit("crop")} disabled={exporting}>
              Recortar
            </button>
            <button className={fit === "pad" ? "active" : ""} aria-pressed={fit === "pad"} onClick={() => setFit("pad")} disabled={exporting}>
              Barras negras
            </button>
          </div>
          <span className="hint small">
            {fit === "crop" ? "Llena el cuadro; en cada clip eliges qué parte queda." : "Muestra la imagen completa con barras."}
          </span>
        </div>
      )}

      <label className="field">
        Resolución
        <select value={size} onChange={(e) => setSize(e.target.value)} disabled={exporting}>
          {SIZES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
              {first && ratio ? ` (${outputSize(first, ratio, reframes ? fit : "crop", s.id).w}×${outputSize(first, ratio, reframes ? fit : "crop", s.id).h})` : ""}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        Formato de archivo
        <select value={codec} onChange={(e) => setCodec(e.target.value as Codec)} disabled={exporting}>
          <option value="hevc">H.265 (HEVC) 10 bits</option>
          <option value="h264">H.264 8 bits (más compatible)</option>
        </select>
      </label>

      <label className="field">
        Codificar con
        <select value={encoder} onChange={(e) => setEncoder(e.target.value as Encoder)} disabled={exporting}>
          {hardware && (
            <option value={hardware.encoder} disabled={!hardwareOk}>
              {hardwareName(hardware.encoder)} (rápido){hardwareOk ? "" : " — no disponible"}
            </option>
          )}
          <option value="cpu">Procesador (más lento, archivo más chico)</option>
        </select>
      </label>

      <label className="field">
        Calidad: {quality} <span className="hint small">(menor = mejor, archivo más grande)</span>
        <input type="range" min={14} max={30} value={quality} onChange={(e) => setQuality(Number(e.target.value))} disabled={exporting} />
      </label>

      <label className="field">
        Cuadros por segundo
        <select value={fps} onChange={(e) => setFps(e.target.value)} disabled={exporting}>
          <option value="source">Igual que el primer clip{first ? ` (${Math.round(first.fps * 100) / 100})` : ""}</option>
          {FRAME_RATES.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </label>

      {needsLut && !settings.lutName && <p className="warning">Hay clips con LUT pero no hay LUT elegida en Ajustes.</p>}
      {settings.ffmpegError && <p className="warning">{settings.ffmpegError}</p>}

      {exporting ? (
        <div className="progress-block">
          <div className="progress-label">
            <span>{Math.floor(percent)}%</span>
            <span>{progress?.speed ? `velocidad ${progress.speed}` : "Iniciando…"}</span>
          </div>
          <div className="progress">
            <div style={{ width: `${percent}%` }} />
          </div>
          <button className="secondary" onClick={() => api.cancelExport()}>
            Cancelar
          </button>
        </div>
      ) : (
        <button className="primary wide" onClick={run} disabled={blocked}>
          Exportar video
        </button>
      )}

      {result && (
        <div className="result">
          <p className="hint small">Listo: <span className="mono">{result}</span></p>
          <button className="secondary" onClick={() => revealItemInDir(result)}>
            Mostrar en la carpeta
          </button>
        </div>
      )}
    </div>
  );
}

/** Fecha y hora local para nombres de archivo: 2026-10-23_22-58-47 */
function localStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
