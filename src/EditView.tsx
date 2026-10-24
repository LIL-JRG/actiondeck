import { useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  api,
  errorText,
  fileUrl,
  onExportProgress,
  type ClipInfo,
  type Codec,
  type Encoder,
  type ExportProgress,
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

type Draft = { path: string; name: string; info: ClipInfo; inPoint: number; outPoint: number; applyLut: boolean; editingId: string | null };

export function EditView({ settings, library, timeline, setTimeline, onError }: Props) {
  const videos = useMemo(() => library.filter((f) => f.kind === "video"), [library]);
  const [infos, setInfos] = useState<Record<string, ClipInfo | string>>({});
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const hasLut = settings.lutName !== null;

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
    setDraft({ path: file.path, name: file.name, info, inPoint: 0, outPoint: info.duration, applyLut: hasLut, editingId: null });
  };

  const editItem = (item: TimelineItem) =>
    setDraft({ ...item, editingId: item.id });

  const commitDraft = () => {
    if (!draft) return;
    const item: TimelineItem = {
      id: draft.editingId ?? crypto.randomUUID(),
      path: draft.path,
      name: draft.name,
      inPoint: draft.inPoint,
      outPoint: draft.outPoint,
      applyLut: draft.applyLut && hasLut,
      hasAudio: draft.info.hasAudio,
      info: draft.info,
    };
    setTimeline((prev) =>
      draft.editingId ? prev.map((t) => (t.id === draft.editingId ? item : t)) : [...prev, item],
    );
    setDraft({ ...draft, editingId: item.id });
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
            onCommit={commitDraft}
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
        <ExportPanel settings={settings} timeline={timeline} onError={onError} />
      </aside>
    </div>
  );
}

function ClipEditor({
  draft,
  setDraft,
  hasLut,
  onCommit,
  onError,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  hasLut: boolean;
  onCommit: () => void;
  onError: (message: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);
  const [frames, setFrames] = useState<{ before: string; after: string | null; stamp: number } | null>(null);
  const [comparing, setComparing] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .previewSource(draft.path)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setPreviewError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [draft.path]);

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

  const inPct = (draft.inPoint / draft.info.duration) * 100;
  const outPct = (draft.outPoint / draft.info.duration) * 100;

  return (
    <div className="clip-editor">
      <header className="stage-header">
        <div>
          <h2>{draft.name}</h2>
          <p className="hint small">{describeClip(draft.info)}</p>
        </div>
        {!draft.info.browserPlayable && preview && <span className="badge">Vista previa ligera</span>}
      </header>

      <div className="player">
        {preview ? (
          <video ref={videoRef} src={fileUrl(preview)} controls onTimeUpdate={onTime} onSeeked={onTime} preload="auto" />
        ) : (
          <div className="player-placeholder">
            {previewError ?? (draft.info.browserPlayable ? "Cargando…" : "Preparando vista previa del video de 10 bits…")}
          </div>
        )}
      </div>

      <div className="trim-bar" onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        seek(((e.clientX - rect.left) / rect.width) * draft.info.duration);
      }}>
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
        <span className="hint">Duración {formatTime(draft.outPoint - draft.inPoint)}</span>
      </div>

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
  const total = items.reduce((sum, i) => sum + (i.outPoint - i.inPoint), 0);
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

const RESOLUTIONS = [
  { label: "4K (3840×2160)", w: 3840, h: 2160 },
  { label: "2.7K (2688×1512)", w: 2688, h: 1512 },
  { label: "1440p (2560×1440)", w: 2560, h: 1440 },
  { label: "1080p (1920×1080)", w: 1920, h: 1080 },
  { label: "720p (1280×720)", w: 1280, h: 720 },
];
const FRAME_RATES = [24, 25, 30, 48, 50, 60, 100, 120];

function ExportPanel({ settings, timeline, onError }: { settings: Settings; timeline: TimelineItem[]; onError: (m: string) => void }) {
  const first = timeline[0]?.info;
  const [codec, setCodec] = useState<Codec>("hevc");
  const [encoder, setEncoder] = useState<Encoder>(settings.nvencHevc ? "nvenc" : "cpu");
  const [quality, setQuality] = useState(20);
  const [resolution, setResolution] = useState("source");
  const [vertical, setVertical] = useState(false);
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

  const nvencOk = codec === "h264" ? settings.nvencH264 : settings.nvencHevc;
  useEffect(() => {
    if (encoder === "nvenc" && !nvencOk) setEncoder("cpu");
  }, [encoder, nvencOk]);

  const size = (() => {
    if (resolution === "source" || !first) return first ? { w: even(first.width), h: even(first.height) } : null;
    const preset = RESOLUTIONS.find((r) => r.label === resolution)!;
    return vertical ? { w: preset.h, h: preset.w } : { w: preset.w, h: preset.h };
  })();
  const frameRate = fps === "source" ? (first ? Math.round(first.fps * 1000) / 1000 : 30) : Number(fps);
  const needsLut = timeline.some((t) => t.applyLut);
  const blocked = timeline.length === 0 || !size || (needsLut && !settings.lutName) || !!settings.ffmpegError;

  const run = async () => {
    if (!size) return;
    const output = await save({
      title: "Guardar video",
      defaultPath: `${settings.libraryDir}\\Exportados\\ActionDeck_${localStamp()}.mp4`,
      filters: [{ name: "Video MP4", extensions: ["mp4"] }],
    });
    if (!output) return;
    setExporting(true);
    setResult(null);
    setProgress(null);
    try {
      const path = await api.startExport(timeline, { output, codec, encoder, quality, width: size.w, height: size.h, fps: frameRate });
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
        Formato
        <select value={codec} onChange={(e) => setCodec(e.target.value as Codec)} disabled={exporting}>
          <option value="hevc">H.265 (HEVC) 10 bits</option>
          <option value="h264">H.264 8 bits (más compatible)</option>
        </select>
      </label>

      <label className="field">
        Codificar con
        <select value={encoder} onChange={(e) => setEncoder(e.target.value as Encoder)} disabled={exporting}>
          <option value="nvenc" disabled={!nvencOk}>
            GPU NVIDIA (rápido){nvencOk ? "" : " — no disponible"}
          </option>
          <option value="cpu">Procesador (más lento, archivo más chico)</option>
        </select>
      </label>

      <label className="field">
        Calidad: {quality} <span className="hint small">(menor = mejor, archivo más grande)</span>
        <input type="range" min={14} max={30} value={quality} onChange={(e) => setQuality(Number(e.target.value))} disabled={exporting} />
      </label>

      <label className="field">
        Resolución
        <select value={resolution} onChange={(e) => setResolution(e.target.value)} disabled={exporting}>
          <option value="source">Igual que el primer clip{first ? ` (${even(first.width)}×${even(first.height)})` : ""}</option>
          {RESOLUTIONS.map((r) => (
            <option key={r.label}>{r.label}</option>
          ))}
        </select>
      </label>
      {resolution !== "source" && (
        <label className="toggle">
          <input type="checkbox" checked={vertical} onChange={(e) => setVertical(e.target.checked)} disabled={exporting} />
          Vertical (9:16)
        </label>
      )}

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

function even(n: number): number {
  return n % 2 === 0 ? n : n - 1;
}
