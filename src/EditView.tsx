import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, Reorder } from "motion/react";
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
  COLOR_MODE_NAMES,
  type Lut,
  type Encoder,
  type ExportProgress,
  type Fit,
  type MediaFile,
  type Settings,
  type TimelineItem,
  type View360,
} from "./api";
import { Filmstrip } from "./Filmstrip";
import { clampFov, DEFAULT_VIEW, loadLut, PLANET_VIEW, VideoRenderer } from "./gl";
import { GLVideo } from "./GLVideo";
import { LookGallery } from "./LookGallery";
import { describeClip, formatDuration, formatTime } from "./format";
import {
  AspectIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CompareIcon,
  DownloadIcon,
  FeedIcon,
  LogIcon,
  MuteIcon,
  PaletteIcon,
  PauseIcon,
  PhoneIcon,
  PlayIcon,
  PlusIcon,
  ScissorsIcon,
  SparkIcon,
  SpeedIcon,
  SphereIcon,
  SplitIcon,
  TrashIcon,
  VolumeIcon,
  WideIcon,
} from "./icons";
import type { LocalMeta } from "./library";
import { Sheet } from "./Sheet";

/** Herramientas con panel propio. */
export type ToolId = "trim" | "speed" | "volume" | "color" | "filter" | "format" | "pano";

/** Pedido de abrir clips de la biblioteca en el editor (desde el álbum). */
export type EditRequest = { paths: string[]; tool: ToolId | null; nonce: number };

/** Formato del video final; "source" = el del primer clip. */
export type FrameFormat = "source" | "16:9" | "9:16" | "1:1" | "4:5";

const FORMATS: { id: FrameFormat; label: string; short: string; ratio: number | null }[] = [
  { id: "source", label: "Original", short: "Original", ratio: null },
  { id: "16:9", label: "16:9 horizontal", short: "16:9", ratio: 16 / 9 },
  { id: "9:16", label: "9:16 vertical", short: "9:16", ratio: 9 / 16 },
  { id: "1:1", label: "1:1 cuadrado", short: "1:1", ratio: 1 },
  { id: "4:5", label: "4:5 retrato", short: "4:5", ratio: 4 / 5 },
];

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4];

const TOOL_LABELS: Record<ToolId, string> = {
  trim: "Recortar",
  speed: "Velocidad",
  volume: "Volumen",
  color: "Recuperación de color",
  filter: "Filtro",
  format: "Formato",
  pano: "Vista 360",
};

const spring = { type: "spring", stiffness: 420, damping: 36 } as const;

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

/**
 * Un clip completo de la biblioteca, con los ajustes por defecto. Si se grabó
 * en un perfil logarítmico, ya trae la LUT oficial de su cámara.
 */
export function newItem(file: MediaFile, info: ClipInfo): TimelineItem {
  return {
    id: crypto.randomUUID(),
    path: file.path,
    name: file.name,
    inPoint: 0,
    outPoint: info.duration,
    lut: info.suggestedLut,
    look: null,
    lookStrength: 1,
    hasAudio: info.hasAudio,
    speed: 1,
    volume: 1,
    cropX: 0.5,
    cropY: 0.5,
    view: info.pano ? DEFAULT_VIEW : null,
    info,
  };
}

type Props = {
  /** La pestaña está a la vista (al salir se pausa el video). */
  active: boolean;
  settings: Settings;
  luts: Lut[];
  library: MediaFile[];
  meta: LocalMeta;
  timeline: TimelineItem[];
  setTimeline: (update: (prev: TimelineItem[]) => TimelineItem[]) => void;
  request: EditRequest | null;
  onGoSettings: () => void;
  onError: (message: string) => void;
};

export function EditView({ active, settings, luts, library, meta, timeline, setTimeline, request, onGoSettings, onError }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(timeline[0]?.id ?? null);
  const [tool, setTool] = useState<ToolId | null>(null);
  // Formato y encuadre son del proyecto: los usan el marco de recorte y la exportación.
  const [format, setFormat] = useState<FrameFormat>("source");
  const [fit, setFit] = useState<Fit>("crop");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [current, setCurrent] = useState(0);

  const selected = timeline.find((t) => t.id === selectedId) ?? timeline[0] ?? null;
  const first = timeline[0]?.info;
  const targetRatio = FORMATS.find((f) => f.id === format)?.ratio ?? (first ? clipRatio(first) : null);
  const total = timeline.reduce((sum, i) => sum + outputDuration(i), 0);

  const update = (patch: Partial<TimelineItem>) => {
    if (!selected) return;
    setTimeline((prev) => prev.map((t) => (t.id === selected.id ? { ...t, ...patch } : t)));
  };

  const addFiles = async (files: MediaFile[]) => {
    const items: TimelineItem[] = [];
    for (const file of files) {
      let info = meta.infos[file.path];
      if (!info || typeof info === "string") {
        try {
          info = await api.probe(file.path);
        } catch (e) {
          onError(`${file.name}: ${errorText(e)}`);
          continue;
        }
      }
      items.push(newItem(file, info));
    }
    if (items.length === 0) return;
    setTimeline((prev) => [...prev, ...items]);
    setSelectedId(items[0].id);
  };

  // Desde el álbum: un clip con una herramienta (el que ya estaba en el
  // proyecto, si lo estaba) o varios clips al final del proyecto.
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!request || handled.current === request.nonce) return;
    handled.current = request.nonce;
    const existing = request.paths.length === 1 ? timeline.find((t) => t.path === request.paths[0]) : undefined;
    if (existing) setSelectedId(existing.id);
    else addFiles(request.paths.map((p) => library.find((f) => f.path === p)).filter((f): f is MediaFile => !!f));
    setTool(request.tool);
    // Solo cuando llega un pedido nuevo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  /** Parte el clip elegido en dos en `at`, cada parte con los mismos ajustes. */
  const split = () => {
    if (!selected || !canSplit) return;
    const second = { ...selected, id: crypto.randomUUID(), inPoint: current };
    setTimeline((prev) => prev.flatMap((t) => (t.id === selected.id ? [{ ...t, outPoint: current }, second] : [t])));
    setSelectedId(second.id);
  };

  const remove = () => {
    if (!selected) return;
    const index = timeline.findIndex((t) => t.id === selected.id);
    const next = timeline[index + 1] ?? timeline[index - 1] ?? null;
    setTimeline((prev) => prev.filter((t) => t.id !== selected.id));
    setSelectedId(next?.id ?? null);
    setTool(null);
  };

  const canSplit = !!selected && current > selected.inPoint + 0.2 && current < selected.outPoint - 0.2;

  useEffect(() => {
    if (!active) videoRef.current?.pause();
  }, [active]);

  // Barra espaciadora: reproducir; S: dividir.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (!active || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || pickerOpen || exportOpen) return;
      if (e.key === " ") {
        e.preventDefault();
        const v = videoRef.current;
        if (v) v.paused ? playFromRange(v, selected) : v.pause();
      } else if (e.key.toLowerCase() === "s" && !e.metaKey && !e.ctrlKey) split();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="editor">
      <header className="page-header editor-header">
        <div>
          <h1 className="page-title">Editor</h1>
          <p className="page-sub">
            {timeline.length === 0
              ? "Une, recorta y ajusta tus clips"
              : `${timeline.length} ${timeline.length === 1 ? "clip" : "clips"} · ${formatDuration(total)}`}
          </p>
        </div>
        {timeline.length > 0 && (
          <div className="row">
            <button className={tool === "format" ? "chip active" : "chip"} onClick={() => setTool(tool === "format" ? null : "format")}>
              <AspectIcon size={18} /> {FORMATS.find((f) => f.id === format)?.short}
            </button>
            <button className="pill primary" onClick={() => setExportOpen(true)}>
              <DownloadIcon size={18} /> Exportar
            </button>
          </div>
        )}
      </header>

      {timeline.length === 0 || !selected ? (
        <EmptyEditor hasVideos={library.some((f) => f.kind === "video")} onAdd={() => setPickerOpen(true)} />
      ) : (
        <>
          <ClipStage
            key={selected.path}
            item={selected}
            videoRef={videoRef}
            cropRatio={fit === "crop" ? targetRatio : null}
            frameRatio={targetRatio}
            onCrop={(cropX, cropY) => update({ cropX, cropY })}
            onView={(view) => update({ view })}
            onTrim={(inPoint, outPoint) => update({ inPoint, outPoint })}
            onTime={setCurrent}
          />

          <EditorBar
            item={selected}
            tool={tool}
            setTool={setTool}
            current={current}
            canSplit={canSplit}
            luts={luts}
            videoRef={videoRef}
            format={format}
            setFormat={setFormat}
            fit={fit}
            setFit={setFit}
            reframes={!!first && targetRatio !== null && Math.abs(targetRatio - clipRatio(first)) > 0.01}
            update={update}
            onSplit={split}
            onRemove={remove}
            onGoSettings={onGoSettings}
            onError={onError}
          />

          <ProjectStrip
            items={timeline}
            setItems={setTimeline}
            selectedId={selected.id}
            thumbs={meta.thumbs}
            onSelect={(id) => setSelectedId(id)}
            onAdd={() => setPickerOpen(true)}
          />
        </>
      )}

      <LibraryPicker
        open={pickerOpen}
        library={library}
        meta={meta}
        onClose={() => setPickerOpen(false)}
        onAdd={(files) => {
          setPickerOpen(false);
          addFiles(files);
        }}
      />

      <ExportSheet
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        settings={settings}
        timeline={timeline}
        current={selected}
        videoRef={videoRef}
        format={format}
        setFormat={setFormat}
        fit={fit}
        setFit={setFit}
        onError={onError}
      />
    </div>
  );
}

/** Reproduce dentro del recorte: si el cabezal está fuera, empieza desde el inicio. */
function playFromRange(v: HTMLVideoElement, item: TimelineItem | null) {
  if (item && (v.currentTime < item.inPoint || v.currentTime >= item.outPoint - 0.05)) v.currentTime = item.inPoint;
  v.play().catch(() => {});
}

function EmptyEditor({ hasVideos, onAdd }: { hasVideos: boolean; onAdd: () => void }) {
  return (
    <motion.div className="empty-editor" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <div className="empty-art" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <h2>Crea tu video</h2>
      <p className="hint">
        {hasVideos
          ? "Agrega clips de tu biblioteca: los recortas, cambias su velocidad, los pones en vertical y los exportas en uno solo."
          : "Primero importa videos desde la cámara en Álbum."}
      </p>
      {hasVideos && (
        <button className="pill primary large" onClick={onAdd}>
          <PlusIcon size={20} /> Agregar clips
        </button>
      )}
    </motion.div>
  );
}

/** Tamaño de un elemento, actualizado al cambiar la ventana. */
function useSize<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

/**
 * El video del clip elegido, con la velocidad y el volumen aplicados, y el
 * marco del formato final encima. Debajo, la tira con los bordes del recorte.
 */
function ClipStage({
  item,
  videoRef,
  cropRatio,
  frameRatio,
  onCrop,
  onView,
  onTrim,
  onTime,
}: {
  item: TimelineItem;
  videoRef: RefObject<HTMLVideoElement | null>;
  cropRatio: number | null;
  /** Formato del video final: un 360 se ve directamente así. */
  frameRatio: number | null;
  onCrop: (x: number, y: number) => void;
  onView: (view: View360) => void;
  onTrim: (inPoint: number, outPoint: number) => void;
  onTime: (t: number) => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [forceProxy, setForceProxy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [stageRef, stageSize] = useSize<HTMLDivElement>();

  useEffect(() => {
    let alive = true;
    setPreview(null);
    api
      .previewSource(item.path, forceProxy)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setPreviewError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [item.path, forceProxy]);

  // Al elegir otro clip (o una parte de uno dividido), el cabezal va a su inicio.
  useEffect(() => {
    const v = videoRef.current;
    if (v && (v.currentTime < item.inPoint || v.currentTime > item.outPoint)) v.currentTime = item.inPoint;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  // La vista previa reproduce con la velocidad y el volumen elegidos. El
  // reproductor no sube de 100 %: arriba de eso solo se nota al exportar.
  const applyPlayback = () => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = item.speed;
    v.volume = Math.min(1, item.volume);
    v.muted = item.volume === 0;
  };
  useEffect(applyPlayback, [item.speed, item.volume, preview, videoRef]);

  const onLoaded = () => {
    const v = videoRef.current;
    if (v) v.currentTime = item.inPoint;
    applyPlayback();
  };

  // Al reproducir dentro del recorte, se detiene en el punto final.
  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    onTime(v.currentTime);
    if (!v.paused && v.currentTime >= item.outPoint) {
      v.pause();
      v.currentTime = item.outPoint;
    }
  };

  const pano = item.info.pano;
  const view = pano ? (item.view ?? DEFAULT_VIEW) : null;
  // Un 360 no tiene un encuadre propio: se ve ya en el formato final.
  const sourceRatio = pano ? (frameRatio ?? 16 / 9) : clipRatio(item.info);
  const frame = (() => {
    const { width, height } = stageSize;
    if (!width || !height) return null;
    return width / height > sourceRatio ? { width: height * sourceRatio, height } : { width, height: width / sourceRatio };
  })();
  const showCrop = !pano && cropRatio !== null && Math.abs(cropRatio - sourceRatio) > 0.01;
  const lowRes = !!preview && preview !== item.path;

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) playFromRange(v, item);
    else v.pause();
  };

  return (
    <>
      <div className="editor-stage" ref={stageRef} onClick={toggle}>
        {preview && frame ? (
          <div className="frame" style={{ width: frame.width, height: frame.height }}>
            <GLVideo
              src={fileUrl(preview)}
              videoRef={videoRef}
              lut={item.lut}
              look={item.look}
              lookAmount={item.lookStrength}
              view={view}
              onView={pano ? onView : undefined}
              videoProps={{
                onTimeUpdate,
                onSeeked: onTimeUpdate,
                onLoadedMetadata: onLoaded,
                onPlay: () => setPlaying(true),
                onPause: () => setPlaying(false),
                onError: () => (forceProxy ? setPreviewError("No se pudo reproducir la vista previa.") : setForceProxy(true)),
              }}
            >
              {showCrop && cropRatio !== null && (
                <CropFrame sourceRatio={sourceRatio} targetRatio={cropRatio} x={item.cropX} y={item.cropY} onMove={onCrop} />
              )}
            </GLVideo>
          </div>
        ) : (
          <div className="stage-status">
            {previewError ? <p className="hint">{previewError}</p> : <span className="spinner large" />}
            {!previewError && !item.info.browserPlayable && <p className="hint small">Preparando vista previa ligera…</p>}
          </div>
        )}
        {lowRes && <span className="stage-tag">{pano ? "360 · Baja res." : "Baja res."}</span>}
        {pano && !playing && preview && <span className="stage-hint">Arrastra para mirar alrededor · rueda para acercar</span>}
        <AnimatePresence>
          {!playing && preview && (
            <motion.span
              className="stage-play"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.2 }}
              transition={{ duration: 0.18 }}
            >
              <PlayIcon size={30} />
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <div className="editor-strip">
        <button className="round ghost" onClick={toggle} aria-label={playing ? "Pausa" : "Reproducir"}>
          {playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
        </button>
        <Filmstrip
          videoRef={videoRef}
          src={preview ? fileUrl(preview) : null}
          duration={item.info.duration}
          look={{ lut: item.lut, look: item.look, lookAmount: item.lookStrength, view }}
          trim={{
            inPoint: item.inPoint,
            outPoint: item.outPoint,
            onChange: onTrim,
          }}
          height={52}
        />
        <span className="strip-meta" title={describeClip(item.info)}>
          {formatTime(outputDuration(item))}
          {item.speed !== 1 && <em>{formatSpeed(item.speed)}</em>}
        </span>
      </div>
    </>
  );
}

/**
 * Marco del formato de salida sobre el video. Lo de fuera se oscurece; el
 * marco se arrastra para elegir qué parte de la imagen queda.
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
  const drag = useRef<{ startX: number; startY: number; x: number; y: number; box: DOMRect; moved: boolean } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const box = e.currentTarget.parentElement?.getBoundingClientRect();
    if (!box) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, x, y, box, moved: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.moved = true;
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
      <div
        className="crop-box"
        style={{ left: pct(left), top: pct(top), width: pct(w), height: pct(h) }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={(e) => e.stopPropagation()}
        title="Arrastra para elegir qué parte de la imagen queda"
      >
        <span className="crop-grid" />
        <span className="crop-hint">Arrastra para encuadrar</span>
      </div>
    </div>
  );
}

const BAR_TOOLS: { id: ToolId | "split" | "remove"; label: string; icon: typeof ScissorsIcon; only360?: boolean }[] = [
  { id: "pano", label: "Vista 360", icon: SphereIcon, only360: true },
  { id: "trim", label: "Recortar", icon: ScissorsIcon },
  { id: "split", label: "Dividir", icon: SplitIcon },
  { id: "speed", label: "Velocidad", icon: SpeedIcon },
  { id: "volume", label: "Volumen", icon: VolumeIcon },
  { id: "color", label: "Recuperación de color", icon: LogIcon },
  { id: "filter", label: "Filtro", icon: PaletteIcon },
  { id: "format", label: "Formato", icon: AspectIcon },
  { id: "remove", label: "Quitar", icon: TrashIcon },
];

/** Fila de herramientas de Mimo: al elegir una, la fila se vuelve su panel. */
function EditorBar({
  item,
  tool,
  setTool,
  current,
  canSplit,
  luts,
  videoRef,
  format,
  setFormat,
  fit,
  setFit,
  reframes,
  update,
  onSplit,
  onRemove,
  onGoSettings,
  onError,
}: {
  item: TimelineItem;
  tool: ToolId | null;
  setTool: (t: ToolId | null) => void;
  current: number;
  canSplit: boolean;
  luts: Lut[];
  videoRef: RefObject<HTMLVideoElement | null>;
  format: FrameFormat;
  setFormat: (f: FrameFormat) => void;
  fit: Fit;
  setFit: (f: Fit) => void;
  reframes: boolean;
  update: (patch: Partial<TimelineItem>) => void;
  onSplit: () => void;
  onRemove: () => void;
  onGoSettings: () => void;
  onError: (message: string) => void;
}) {
  const [compare, setCompare] = useState<{ before: string; after: string | null; stamp: number } | null>(null);
  const [comparing, setComparing] = useState(false);

  const runCompare = async () => {
    setComparing(true);
    try {
      const pair = await api.compareFrames(item.path, current, item.lut, item.look, item.lookStrength, item.view);
      setCompare({ ...pair, stamp: Date.now() });
    } catch (e) {
      onError(errorText(e));
    } finally {
      setComparing(false);
    }
  };

  const official = luts.filter((l) => l.kind === "conversion");
  const length = item.outPoint - item.inPoint;
  const slowMotionNote =
    item.speed < 1
      ? item.info.fps * item.speed >= 24
        ? `Cámara lenta fluida: se grabó a ${Math.round(item.info.fps)} fps.`
        : `Se verá entrecortado: se grabó a ${Math.round(item.info.fps)} fps. Para cámara lenta fluida, graba a 100 o 120 fps.`
      : null;

  return (
    <div className="editor-bar">
      <AnimatePresence mode="wait" initial={false}>
        {tool === null ? (
          <motion.nav
            key="tools"
            className="tool-row"
            aria-label="Herramientas"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.16 }}
          >
            {BAR_TOOLS.filter((t) => !t.only360 || item.info.pano).map((t) => {
              const disabled = t.id === "split" && !canSplit;
              const active =
                (t.id === "speed" && item.speed !== 1) ||
                (t.id === "volume" && item.volume !== 1) ||
                (t.id === "color" && item.lut !== null) ||
                (t.id === "filter" && item.look !== null) ||
                (t.id === "trim" && (item.inPoint > 0 || item.outPoint < item.info.duration));
              return (
                <button
                  key={t.id}
                  className={active ? "tool on" : "tool"}
                  disabled={disabled}
                  title={t.id === "split" ? (canSplit ? `Dividir en ${formatTime(current)} (S)` : "Mueve el cabezal dentro del clip para dividirlo") : undefined}
                  onClick={() => (t.id === "split" ? onSplit() : t.id === "remove" ? onRemove() : setTool(t.id))}
                >
                  <t.icon size={26} />
                  <span>{t.label}</span>
                  {active && <i className="tool-dot" />}
                </button>
              );
            })}
          </motion.nav>
        ) : (
          <motion.section
            key={tool}
            className="tool-panel"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 14 }}
            transition={{ duration: 0.18 }}
          >
            <header className="tool-panel-head">
              <span>{TOOL_LABELS[tool]}</span>
              <button className="round small" onClick={() => setTool(null)} aria-label="Listo">
                <CheckIcon size={20} />
              </button>
            </header>

            {tool === "trim" && (
              <div className="tool-body">
                <div className="stat">
                  <span>Inicio</span>
                  <strong>{formatTime(item.inPoint)}</strong>
                </div>
                <button className="chip" onClick={() => update({ inPoint: Math.min(current, item.outPoint - 0.2) })}>
                  Inicio aquí
                </button>
                <div className="stat">
                  <span>Duración</span>
                  <strong>{formatTime(length)}</strong>
                </div>
                <button className="chip" onClick={() => update({ outPoint: Math.max(current, item.inPoint + 0.2) })}>
                  Fin aquí
                </button>
                <div className="stat">
                  <span>Fin</span>
                  <strong>{formatTime(item.outPoint)}</strong>
                </div>
                <p className="hint small wide">También puedes arrastrar los bordes amarillos de la tira.</p>
              </div>
            )}

            {tool === "speed" && (
              <div className="tool-body column">
                <ChipGroup
                  options={SPEEDS.map((s) => ({ id: String(s), label: formatSpeed(s) }))}
                  value={String(item.speed)}
                  onChange={(v) => update({ speed: Number(v) })}
                  layoutId="speed-chip"
                />
                <p className="hint small">
                  Duración {formatTime(length / item.speed)}
                  {item.speed !== 1 && ` (original ${formatTime(length)})`}
                  {slowMotionNote && <> · {slowMotionNote}</>}
                </p>
              </div>
            )}

            {tool === "volume" && (
              <div className="tool-body">
                {item.info.hasAudio ? (
                  <>
                    <button
                      className={item.volume === 0 ? "round on" : "round"}
                      onClick={() => update({ volume: item.volume === 0 ? 1 : 0 })}
                      aria-label={item.volume === 0 ? "Activar sonido" : "Silenciar"}
                      title={item.volume === 0 ? "Activar sonido" : "Silenciar"}
                    >
                      {item.volume === 0 ? <MuteIcon size={22} /> : <VolumeIcon size={22} />}
                    </button>
                    <input
                      className="slider"
                      type="range"
                      min={0}
                      max={200}
                      step={5}
                      value={Math.round(item.volume * 100)}
                      onChange={(e) => update({ volume: Number(e.target.value) / 100 })}
                      aria-label="Volumen"
                      style={{ ["--fill" as string]: `${item.volume * 50}%` }}
                    />
                    <span className="slider-value">{Math.round(item.volume * 100)} %</span>
                  </>
                ) : (
                  <p className="hint">Este clip no tiene sonido.</p>
                )}
              </div>
            )}

            {tool === "color" && (
              <div className="tool-body">
                <label className="switch-row">
                  <span>
                    <strong>Recuperar color</strong>
                    <span className="hint small">{profileText(item.info)}</span>
                  </span>
                  <Switch
                    checked={item.lut !== null}
                    onChange={(on) => update({ lut: on ? (item.info.suggestedLut ?? official[0]?.id ?? null) : null })}
                  />
                </label>
                {item.lut !== null && (
                  <select className="select" value={item.lut} onChange={(e) => update({ lut: e.target.value })} aria-label="LUT">
                    {official.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} · {l.detail}
                        {l.id === item.info.suggestedLut ? " (la de esta cámara)" : ""}
                      </option>
                    ))}
                  </select>
                )}
                <button className="chip" onClick={runCompare} disabled={comparing || (item.lut === null && item.look === null)}>
                  <CompareIcon size={18} /> {comparing ? "Generando…" : `Antes y después en ${formatTime(current)}`}
                </button>
              </div>
            )}

            {tool === "filter" && (
              <div className="tool-body column">
                <LookGallery
                  luts={luts}
                  value={item.look}
                  strength={item.lookStrength}
                  onChange={(look) => update({ look })}
                  onStrength={(lookStrength) => update({ lookStrength })}
                  videoRef={videoRef}
                  frameKey={item.path}
                  conversion={item.lut}
                  view={item.view}
                  onMore={onGoSettings}
                  action={
                    <button
                      className="chip small"
                      onClick={runCompare}
                      disabled={comparing || (item.lut === null && item.look === null)}
                      title={`Antes y después en ${formatTime(current)}, como queda al exportar`}
                    >
                      <CompareIcon size={16} /> {comparing ? "Generando…" : "Antes y después"}
                    </button>
                  }
                />
              </div>
            )}

            {tool === "pano" && item.view && (
              <div className="tool-body column">
                <ChipGroup
                  options={[
                    { id: "flat", label: "Normal" },
                    { id: "planet", label: "Pequeño planeta" },
                  ]}
                  value={item.view.mode}
                  onChange={(mode) =>
                    update({ view: { ...(mode === "planet" ? PLANET_VIEW : DEFAULT_VIEW), yaw: item.view?.yaw ?? 0 } })
                  }
                  layoutId="pano-mode"
                />
                <div className="row center">
                  <span className="hint small">Campo de visión</span>
                  <input
                    className="slider"
                    type="range"
                    min={item.view.mode === "planet" ? 120 : 30}
                    max={item.view.mode === "planet" ? 330 : 150}
                    value={Math.round(item.view.fov)}
                    onChange={(e) => item.view && update({ view: { ...item.view, fov: clampFov(item.view, Number(e.target.value)) } })}
                    aria-label="Campo de visión"
                    style={{ ["--fill" as string]: `${fovFill(item.view)}%` }}
                  />
                  <span className="slider-value">{Math.round(item.view.fov)}°</span>
                  <button className="chip" onClick={() => item.view && update({ view: { ...item.view, yaw: 0, pitch: item.view.mode === "planet" ? -90 : 0, roll: 0 } })}>
                    Al frente
                  </button>
                  <button className="chip" onClick={() => item.view && update({ view: { ...item.view, yaw: 180, pitch: item.view.mode === "planet" ? -90 : 0, roll: 0 } })}>
                    Atrás
                  </button>
                </div>
                <p className="hint small">Arrastra el video para mirar alrededor; con la rueda acercas o alejas.</p>
              </div>
            )}

            {tool === "format" && (
              <div className="tool-body column">
                <ChipGroup
                  options={FORMATS.map((f) => ({ id: f.id, label: f.short }))}
                  value={format}
                  onChange={(v) => setFormat(v as FrameFormat)}
                  layoutId="format-chip"
                />
                {reframes ? (
                  <div className="row">
                    <ChipGroup
                      options={[
                        { id: "crop", label: "Recortar" },
                        { id: "pad", label: "Barras negras" },
                      ]}
                      value={fit}
                      onChange={(v) => setFit(v as Fit)}
                      layoutId="fit-chip"
                    />
                    <span className="hint small">
                      {fit === "crop" ? "Llena el cuadro: arrastra el marco en cada clip para encuadrar." : "Muestra la imagen completa con barras."}
                    </span>
                  </div>
                ) : (
                  <p className="hint small">Aplica a todo el video. En vertical o cuadrado eliges el encuadre de cada clip.</p>
                )}
              </div>
            )}
          </motion.section>
        )}
      </AnimatePresence>

      {createPortal(
        <AnimatePresence>
          {compare && (
            <CompareOverlay
              before={fileUrl(compare.before, compare.stamp)}
              after={compare.after ? fileUrl(compare.after, compare.stamp) : null}
              onClose={() => setCompare(null)}
            />
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

/** Qué tanto del deslizador del campo de visión va lleno (0-100). */
function fovFill(view: View360): number {
  const [min, max] = view.mode === "planet" ? [120, 330] : [30, 150];
  return ((view.fov - min) / (max - min)) * 100;
}

/** "Grabado en D-Log M con la Osmo Action 5 Pro" y si necesita conversión. */
function profileText(info: ClipInfo): string {
  if (!info.colorMode) return "No pude leer el perfil de color de este clip.";
  const where = `Grabado en ${COLOR_MODE_NAMES[info.colorMode]}${info.device ? ` con la ${info.device}` : ""}`;
  return info.suggestedLut ? `${where}: se convierte con la LUT oficial de DJI.` : `${where}: no necesita conversión.`;
}

/** Antes y después con una cortina que se arrastra. */
function CompareOverlay({ before, after, onClose }: { before: string; after: string | null; onClose: () => void }) {
  const [split, setSplit] = useState(0.5);
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1 && e.type !== "pointerdown") return;
    const rect = e.currentTarget.getBoundingClientRect();
    setSplit(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
  };
  return (
    <motion.div className="compare-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="compare-card"
        onClick={(e) => e.stopPropagation()}
        initial={{ scale: 0.96, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 10 }}
        transition={spring}
      >
        <div className="compare-view" onPointerDown={move} onPointerMove={move}>
          <img src={before} alt="Original" draggable={false} />
          {after && <img src={after} alt="Con LUT" draggable={false} style={{ clipPath: `inset(0 0 0 ${split * 100}%)` }} />}
          {after && <span className="compare-line" style={{ left: `${split * 100}%` }} />}
          <span className="compare-label left">Original</span>
          {after && <span className="compare-label right">Color recuperado</span>}
        </div>
        <button className="round compare-close" onClick={onClose} aria-label="Cerrar">
          <CloseIcon size={20} />
        </button>
      </motion.div>
    </motion.div>
  );
}

export function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={checked ? "switch on" : "switch"}
      onClick={() => onChange(!checked)}
    >
      <motion.span layout transition={spring} />
    </button>
  );
}

/** Chips de opción única con el resaltado que se desliza, como los filtros de Mimo. */
export function ChipGroup({
  options,
  value,
  onChange,
  layoutId,
  disabled,
}: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  layoutId: string;
  disabled?: boolean;
}) {
  return (
    <div className="chip-group" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          className={value === o.id ? "chip-option active" : "chip-option"}
          onClick={() => onChange(o.id)}
          disabled={disabled}
        >
          {value === o.id && <motion.span layoutId={layoutId} className="chip-highlight" transition={spring} />}
          <span className="chip-text">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Clips del proyecto en orden; se reordenan arrastrando. */
function ProjectStrip({
  items,
  setItems,
  selectedId,
  thumbs,
  onSelect,
  onAdd,
}: {
  items: TimelineItem[];
  setItems: (update: (prev: TimelineItem[]) => TimelineItem[]) => void;
  selectedId: string;
  thumbs: Record<string, string>;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="project-strip">
      <Reorder.Group axis="x" values={items} onReorder={(next) => setItems(() => next)} className="project-items">
        {items.map((item, i) => {
          const width = Math.min(220, Math.max(76, outputDuration(item) * 10));
          return (
            <Reorder.Item
              key={item.id}
              value={item}
              className={item.id === selectedId ? "project-item selected" : "project-item"}
              style={{ width }}
              onClick={() => onSelect(item.id)}
              whileDrag={{ scale: 1.06, zIndex: 2, boxShadow: "0 12px 30px rgba(0,0,0,0.6)" }}
              title={`${item.name} · arrastra para cambiar el orden`}
            >
              {thumbs[item.path] && <img src={thumbs[item.path]} alt="" draggable={false} />}
              <span className="project-index">{i + 1}</span>
              <span className="project-badges">
                {item.speed !== 1 && <em>{formatSpeed(item.speed)}</em>}
                {item.hasAudio && item.volume === 0 && <MuteIcon size={14} />}
                {item.lut && <em>LUT</em>}
                {item.look && <em>Filtro</em>}
              </span>
              <span className="project-length">{formatTime(outputDuration(item))}</span>
            </Reorder.Item>
          );
        })}
      </Reorder.Group>
      <button className="project-add" onClick={onAdd} aria-label="Agregar clips">
        <PlusIcon />
      </button>
    </div>
  );
}

/** Videos de la biblioteca para agregar al proyecto. */
function LibraryPicker({
  open,
  library,
  meta,
  onClose,
  onAdd,
}: {
  open: boolean;
  library: MediaFile[];
  meta: LocalMeta;
  onClose: () => void;
  onAdd: (files: MediaFile[]) => void;
}) {
  const videos = useMemo(() => library.filter((f) => f.kind === "video").sort((a, b) => b.modifiedMs - a.modifiedMs), [library]);
  const [chosen, setChosen] = useState<string[]>([]);
  useEffect(() => {
    if (open) setChosen([]);
  }, [open]);

  const toggle = (path: string) => setChosen((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]));

  return (
    <Sheet open={open} onClose={onClose} className="picker-sheet" label="Agregar clips">
      <header className="sheet-head">
        <h2>Agregar clips</h2>
        <button className="round small" onClick={onClose} aria-label="Cerrar">
          <CloseIcon size={20} />
        </button>
      </header>
      {videos.length === 0 ? (
        <p className="hint">No hay videos en la biblioteca. Impórtalos desde Álbum.</p>
      ) : (
        <ul className="picker-grid">
          {videos.map((f) => {
            const info = meta.infos[f.path];
            const order = chosen.indexOf(f.path);
            const unreadable = typeof info === "string";
            return (
              <li key={f.path}>
                <button
                  className={order >= 0 ? "picker-tile selected" : "picker-tile"}
                  onClick={() => toggle(f.path)}
                  disabled={unreadable}
                  title={unreadable ? info : f.name}
                >
                  {meta.thumbs[f.path] && <img src={meta.thumbs[f.path]} alt="" draggable={false} />}
                  {info && typeof info !== "string" && <span className="tile-duration">{formatDuration(info.duration)}</span>}
                  <span className="select-dot">{order >= 0 ? order + 1 : ""}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <footer className="sheet-foot">
        <span className="hint">{chosen.length === 0 ? "Elige en el orden en que van" : `${chosen.length} elegidos`}</span>
        <button
          className="pill primary"
          disabled={chosen.length === 0}
          onClick={() => onAdd(chosen.map((p) => videos.find((v) => v.path === p)!).filter(Boolean))}
        >
          Agregar {chosen.length > 0 ? chosen.length : ""}
        </button>
      </footer>
    </Sheet>
  );
}

/** Lado corto del video final; "max" = lo más que da el clip sin agrandarlo. */
const SIZES = [
  { id: "max", label: "Máxima" },
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
    return keepsHeight ? { w: even(first.height * ratio), h: even(first.height) } : { w: even(first.width), h: even(first.width / ratio) };
  }
  const short = Number(size);
  return ratio >= 1 ? { w: even(short * ratio), h: even(short) } : { w: even(short), h: even(short / ratio) };
}

type Quality = "standard" | "high" | "max";

/** Calidad en palabras; por dentro, el CRF (menor = mejor). */
const QUALITIES: { id: Quality; label: string; crf: number; note: string }[] = [
  { id: "standard", label: "Estándar", crf: 23, note: "Archivo liviano, bien para compartir rápido." },
  { id: "high", label: "Alta", crf: 20, note: "Lo recomendado: casi no se distingue del original." },
  { id: "max", label: "Máxima", crf: 16, note: "Para guardar o seguir editando; pesa más." },
];

type Destination = {
  id: string;
  label: string;
  note: string;
  icon: typeof PhoneIcon;
  format: FrameFormat;
  size: string;
  codec: Codec;
  quality: Quality;
  /** Hasta cuántos cuadros por segundo (null = los del clip). */
  maxFps: number | null;
};

/** Para dónde es el video: cada uno deja todo listo de una vez. */
const DESTINATIONS: Destination[] = [
  { id: "vertical", label: "Redes verticales", note: "TikTok, Reels y Shorts", icon: PhoneIcon, format: "9:16", size: "1080", codec: "h264", quality: "high", maxFps: 60 },
  { id: "youtube", label: "YouTube", note: "Horizontal, a la mayor resolución", icon: WideIcon, format: "16:9", size: "max", codec: "hevc", quality: "high", maxFps: 60 },
  { id: "feed", label: "Publicación", note: "Instagram y Facebook, 4:5", icon: FeedIcon, format: "4:5", size: "1080", codec: "h264", quality: "high", maxFps: 60 },
  { id: "archive", label: "Máxima calidad", note: "Formato original, para guardar", icon: SparkIcon, format: "source", size: "max", codec: "hevc", quality: "max", maxFps: null },
];

/** Bits por píxel aproximados de cada calidad en H.265; H.264 pesa ~1,6 veces más. */
const BITS_PER_PIXEL: Record<Quality, number> = { standard: 0.05, high: 0.08, max: 0.14 };

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1).replace(".", ",")} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function formatRemaining(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? `${m} min ${s} s` : `${m} min`;
}

/** El cuadro actual tal como se verá: con su LUT, su filtro y, si es 360, su vista. */
async function snapshot(video: HTMLVideoElement, item: TimelineItem, outRatio: number): Promise<string | null> {
  if (video.readyState < 2 || !video.videoWidth) return null;
  const pano = item.info.pano;
  const ratio = pano ? outRatio : video.videoWidth / video.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = ratio >= 1 ? 640 : Math.round(640 * ratio);
  canvas.height = Math.round(canvas.width / ratio);
  if (VideoRenderer.supported() && (item.lut || item.look || pano)) {
    let r: VideoRenderer | null = null;
    try {
      r = new VideoRenderer(canvas);
      r.view = pano ? (item.view ?? DEFAULT_VIEW) : null;
      r.lookAmount = item.lookStrength;
      const [lut, look] = await Promise.all([item.lut ? loadLut(item.lut) : null, item.look ? loadLut(item.look) : null]);
      r.setLut(0, lut);
      r.setLut(1, look);
      if (!r.draw(video)) return null;
      return canvas.toDataURL("image/jpeg", 0.85);
    } catch {
      return null;
    } finally {
      r?.dispose(true);
    }
  }
  canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function ExportSheet({
  open,
  onClose,
  settings,
  timeline,
  current,
  videoRef,
  format,
  setFormat,
  fit,
  setFit,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  timeline: TimelineItem[];
  /** El clip que se está viendo: de él sale la vista previa. */
  current: TimelineItem | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  format: FrameFormat;
  setFormat: (f: FrameFormat) => void;
  fit: Fit;
  setFit: (f: Fit) => void;
  onError: (m: string) => void;
}) {
  const first = timeline[0]?.info;
  const hardware = settings.hardware;
  const [codec, setCodec] = useState<Codec>("hevc");
  const [encoder, setEncoder] = useState<Encoder>(hardware?.hevc ? hardware.encoder : "cpu");
  const [quality, setQuality] = useState<Quality>("high");
  const [size, setSize] = useState("max");
  const [fps, setFps] = useState("source");
  const [advanced, setAdvanced] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
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
    else if (encoder === "cpu" && hardwareOk && hardware) setEncoder(hardware.encoder);
    // Solo al cambiar de archivo: si elige el procesador a mano, se respeta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codec, hardwareOk]);

  const sourceFps = first ? Math.round(first.fps * 1000) / 1000 : 30;
  const presetFps = (d: Destination) => (d.maxFps !== null && sourceFps > d.maxFps + 0.5 ? String(d.maxFps) : "source");
  const applyDestination = (d: Destination) => {
    setFormat(d.format);
    setSize(d.size);
    setCodec(d.codec);
    setQuality(d.quality);
    setFps(presetFps(d));
  };
  const destination = DESTINATIONS.find(
    (d) => d.format === format && d.size === size && d.codec === codec && d.quality === quality && presetFps(d) === fps,
  );

  // Al abrir, el destino que corresponde al formato elegido en el editor.
  useEffect(() => {
    if (!open || exporting) return;
    setResult(null);
    const match = DESTINATIONS.find((d) => d.format === format);
    if (match) applyDestination(match);
    else {
      setSize("1080");
      setCodec("h264");
      setQuality("high");
      setFps(sourceFps > 60.5 ? "60" : "source");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const ratio = FORMATS.find((f) => f.id === format)?.ratio ?? (first ? clipRatio(first) : null);
  const reframes = !!first && ratio !== null && Math.abs(ratio - clipRatio(first)) > 0.01;
  const effectiveFit = reframes ? fit : "crop";
  const out = first && ratio ? outputSize(first, ratio, effectiveFit, size) : null;
  const frameRate = fps === "source" ? sourceFps : Number(fps);
  const blocked = timeline.length === 0 || !out || !!settings.ffmpegError;
  const total = timeline.reduce((sum, i) => sum + outputDuration(i), 0);
  const estimate = out ? out.w * out.h * frameRate * total * BITS_PER_PIXEL[quality] * (codec === "h264" ? 1.6 : 1) / 8 : 0;
  const qualityInfo = QUALITIES.find((q) => q.id === quality)!;

  // La vista previa: el cuadro actual en el formato de salida.
  const previewRatio = ratio ?? 16 / 9;
  useEffect(() => {
    if (!open || !current || !videoRef.current) return;
    let alive = true;
    snapshot(videoRef.current, current, previewRatio).then((url) => alive && setPreview(url));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current?.id, current?.lut, current?.look, current?.lookStrength, previewRatio]);

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
        quality: qualityInfo.crf,
        width: out.w,
        height: out.h,
        fps: frameRate,
        fit: effectiveFit,
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
  const speedFactor = progress?.speed ? parseFloat(progress.speed) : NaN;
  const remaining =
    progress && speedFactor > 0 && progress.secondsDone > 0.5 ? (progress.secondsTotal - progress.secondsDone) / speedFactor : null;
  const pano = !!current?.info.pano;
  const cropPos = current && !pano ? `${current.cropX * 100}% ${current.cropY * 100}%` : "50% 50%";
  const locked = exporting;

  return (
    <Sheet open={open} onClose={exporting ? () => {} : onClose} className="export-sheet" side="right" label="Exportar">
      <header className="sheet-head">
        <div>
          <h2>Exportar</h2>
          <p className="hint small">
            {timeline.length} {timeline.length === 1 ? "clip" : "clips"} · {formatDuration(total)}
          </p>
        </div>
        <button className="round small" onClick={onClose} disabled={exporting} aria-label="Cerrar">
          <CloseIcon size={20} />
        </button>
      </header>

      <div className="export-fields">
        <div className="export-preview">
          <motion.div
            className="export-frame"
            layout
            transition={spring}
            style={{ aspectRatio: String(previewRatio), [previewRatio >= 1 ? "width" : "height"]: "100%" }}
          >
            {preview && (
              <img
                src={preview}
                alt=""
                draggable={false}
                style={{ objectFit: pano ? "cover" : effectiveFit === "pad" ? "contain" : "cover", objectPosition: cropPos }}
              />
            )}
          </motion.div>
          {out && (
            <span className="export-badge">
              {out.w}×{out.h} · {Math.round(frameRate * 100) / 100} fps
            </span>
          )}
        </div>

        <Field label="¿Para dónde es?">
          <div className="destinations">
            {DESTINATIONS.map((d) => (
              <button
                key={d.id}
                className={destination?.id === d.id ? "destination on" : "destination"}
                onClick={() => applyDestination(d)}
                disabled={locked}
                aria-pressed={destination?.id === d.id}
              >
                <d.icon size={22} />
                <strong>{d.label}</strong>
                <span>{d.note}</span>
              </button>
            ))}
          </div>
        </Field>

        <Field label="Formato" note={destination ? undefined : "Personalizado"}>
          <ChipGroup
            options={FORMATS.map((f) => ({ id: f.id, label: f.short }))}
            value={format}
            onChange={(v) => {
              setFormat(v as FrameFormat);
              setSize(v === "source" ? "max" : "1080");
            }}
            layoutId="export-format"
            disabled={locked}
          />
        </Field>

        {reframes && (
          <Field label="Encuadre" note={fit === "crop" ? "Llena el cuadro; en el editor eliges qué parte queda." : "Se ve la imagen completa, con barras."}>
            <ChipGroup
              options={[
                { id: "crop", label: "Recortar" },
                { id: "pad", label: "Barras negras" },
              ]}
              value={fit}
              onChange={(v) => setFit(v as Fit)}
              layoutId="export-fit"
              disabled={locked}
            />
          </Field>
        )}

        <Field label="Calidad" note={qualityInfo.note}>
          <ChipGroup
            options={QUALITIES.map((q) => ({ id: q.id, label: q.label }))}
            value={quality}
            onChange={(v) => setQuality(v as Quality)}
            layoutId="export-quality"
            disabled={locked}
          />
        </Field>

        <button className="export-more" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
          <span>Más ajustes</span>
          <span className="hint small">
            {codec === "hevc" ? "H.265" : "H.264"} · {encoder === "cpu" ? "Procesador" : hardwareName(encoder)}
          </span>
          <motion.span animate={{ rotate: advanced ? 180 : 0 }} transition={{ duration: 0.2 }}>
            <ChevronDownIcon size={18} />
          </motion.span>
        </button>

        <AnimatePresence initial={false}>
          {advanced && (
            <motion.div
              className="export-advanced"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22 }}
            >
              <Field label="Resolución" note={out ? `${out.w}×${out.h}` : undefined}>
                <ChipGroup options={SIZES} value={size} onChange={setSize} layoutId="export-size" disabled={locked} />
              </Field>

              <Field label="Archivo" note={codec === "hevc" ? "Mejor calidad por MB; algunos equipos viejos no lo abren." : "Se abre en cualquier lado."}>
                <ChipGroup
                  options={[
                    { id: "hevc", label: "H.265 10 bits" },
                    { id: "h264", label: "H.264" },
                  ]}
                  value={codec}
                  onChange={(v) => setCodec(v as Codec)}
                  layoutId="export-codec"
                  disabled={locked}
                />
              </Field>

              <Field label="Codificar con">
                <ChipGroup
                  options={[
                    ...(hardware && hardwareOk ? [{ id: hardware.encoder, label: `${hardwareName(hardware.encoder)} (rápido)` }] : []),
                    { id: "cpu", label: "Procesador (más lento, archivo más chico)" },
                  ]}
                  value={encoder}
                  onChange={(v) => setEncoder(v as Encoder)}
                  layoutId="export-encoder"
                  disabled={locked}
                />
              </Field>

              <Field label="Cuadros por segundo">
                <select className="select" value={fps} onChange={(e) => setFps(e.target.value)} disabled={locked}>
                  <option value="source">Igual que el primer clip ({Math.round(sourceFps * 100) / 100})</option>
                  {FRAME_RATES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </Field>
            </motion.div>
          )}
        </AnimatePresence>

        {settings.ffmpegError && <p className="warning">{settings.ffmpegError}</p>}
      </div>

      <footer className="export-foot">
        <AnimatePresence mode="wait" initial={false}>
          {exporting ? (
            <motion.div key="progress" className="export-progress" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <div className="export-percent">
                <strong>{Math.floor(percent)}%</strong>
                <span className="hint small">
                  {remaining !== null ? `Quedan unos ${formatRemaining(remaining)}` : "Preparando…"}
                </span>
              </div>
              <div className="bar">
                <motion.div animate={{ width: `${percent}%` }} transition={{ ease: "easeOut", duration: 0.4 }} />
              </div>
              <button className="pill" onClick={() => api.cancelExport()}>
                Cancelar
              </button>
            </motion.div>
          ) : result ? (
            <motion.div key="result" className="export-result" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <motion.span className="done-badge" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 500, damping: 22 }}>
                <CheckIcon size={22} />
              </motion.span>
              <div className="export-result-text">
                <strong>Video listo</strong>
                <span className="mono small">{result}</span>
              </div>
              <button className="pill" onClick={() => revealItemInDir(result)}>
                Mostrar
              </button>
            </motion.div>
          ) : (
            <motion.div key="go" className="export-go" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <button className="pill primary large wide" onClick={run} disabled={blocked}>
                <DownloadIcon size={20} /> Exportar video
              </button>
              {out && <span className="hint small">Archivo de unos {formatBytes(estimate)} · MP4</span>}
            </motion.div>
          )}
        </AnimatePresence>
        {result && !exporting && (
          <button className="link" onClick={() => setResult(null)}>
            Exportar otra versión
          </button>
        )}
      </footer>
    </Sheet>
  );
}

function Field({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">
        {label}
        {note && <span className="field-note">{note}</span>}
      </span>
      {children}
    </div>
  );
}

/** Fecha y hora local para nombres de archivo: 2026-10-23_22-58-47 */
function localStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
