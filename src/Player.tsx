import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api, cameraUrl, fileUrl, type MediaFile } from "./api";
import type { ToolId } from "./EditView";
import { Filmstrip } from "./Filmstrip";
import { describeClip, formatBytes, formatDate, formatDuration } from "./format";
import {
  AspectIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  InfoIcon,
  LogIcon,
  PauseIcon,
  PlayIcon,
  ScissorsIcon,
  SpeedIcon,
  VolumeIcon,
} from "./icons";
import { durationOf, type LocalMeta } from "./library";

type Props = {
  files: MediaFile[];
  index: number;
  /** Los archivos están en la cámara (por Wi-Fi). */
  wireless: boolean;
  meta: LocalMeta | null;
  isImported: (f: MediaFile) => boolean;
  onMove: (index: number) => void;
  onClose: () => void;
  /** Desde la cámara o una unidad: copiar este archivo a la biblioteca. */
  onImport?: (f: MediaFile) => void;
  importing?: boolean;
  /** De la biblioteca: abrirlo en el editor, con una herramienta ya elegida. */
  onEdit?: (f: MediaFile, tool: ToolId) => void;
};

const TOOLS: { id: ToolId; label: string; icon: typeof ScissorsIcon }[] = [
  { id: "trim", label: "Recortar", icon: ScissorsIcon },
  { id: "speed", label: "Velocidad", icon: SpeedIcon },
  { id: "color", label: "Recuperación de color", icon: LogIcon },
  { id: "volume", label: "Volumen", icon: VolumeIcon },
  { id: "format", label: "Formato", icon: AspectIcon },
];

/**
 * Vista de un archivo a pantalla completa, como la de Mimo: barra arriba,
 * tira de cuadros con el cabezal al centro y controles abajo. Por Wi-Fi se
 * reproduce la versión ligera `.LRF` directo de la cámara, sin descargarla.
 */
export function Player({ files, index, wireless, meta, isImported, onMove, onClose, onImport, importing, onEdit }: Props) {
  const file = files[index];
  const isVideo = file.kind === "video";
  const videoRef = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [lowRes, setLowRes] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [triedFallback, setTriedFallback] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [pulse, setPulse] = useState<{ playing: boolean; at: number } | null>(null);

  useEffect(() => {
    setFailed(null);
    setTriedFallback(false);
    setDuration(durationOf(file, meta));
    setPlaying(false);
    if (wireless) {
      const remote = isVideo ? file.proxyPath : file.thumb;
      setSrc(remote ? cameraUrl(remote) : null);
      setLowRes(true);
      if (!remote) setFailed("La cámara no tiene vista previa de este archivo.");
    } else if (!isVideo) {
      setSrc(fileUrl(file.path));
      setLowRes(false);
    } else if (file.proxyPath) {
      setSrc(fileUrl(file.proxyPath));
      setLowRes(true);
    } else {
      loadLocalPreview(false);
    }
    // Solo al cambiar de archivo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);

  const loadLocalPreview = (forceProxy: boolean) => {
    setTriedFallback(true);
    setSrc(null);
    api
      .previewSource(file.path, forceProxy)
      .then((p) => {
        setSrc(fileUrl(p));
        setLowRes(p !== file.path);
      })
      .catch(() => setFailed("No se pudo preparar la vista previa."));
  };

  const onMediaError = () => {
    if (!wireless && isVideo && !triedFallback) loadLocalPreview(false);
    else if (!wireless && isVideo && !lowRes) loadLocalPreview(true);
    else setFailed(wireless ? "No se pudo reproducir la vista previa desde la cámara." : "No se pudo mostrar este archivo.");
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
    setPulse({ playing: v.paused, at: Date.now() });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT") return;
      if (e.key === "Escape") {
        if (showInfo) setShowInfo(false);
        else onClose();
      } else if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft" && index > 0) onMove(index - 1);
      else if (e.key === "ArrowRight" && index < files.length - 1) onMove(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const imported = isImported(file);
  const info = meta?.infos[file.path];
  const clipInfo = info && typeof info !== "string" ? info : null;

  return (
    <motion.div
      className="player-screen"
      role="dialog"
      aria-modal="true"
      aria-label={file.name}
      initial={{ opacity: 0, scale: 0.985 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.985 }}
      transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <div className="titlebar-space" data-tauri-drag-region />
      <header className="player-top">
        <button className="round" onClick={onClose} aria-label="Volver">
          <ChevronLeftIcon />
        </button>
        <button className={showInfo ? "round on" : "round"} onClick={() => setShowInfo((s) => !s)} aria-label="Información">
          <InfoIcon size={22} />
        </button>
        {lowRes && src && <span className="player-tag">Baja res.</span>}
        <div className="player-heading" data-tauri-drag-region>
          <span className="player-name">{file.name}</span>
          <span className="player-count">
            {index + 1} de {files.length}
          </span>
        </div>
        {onImport &&
          (imported ? (
            <span className="player-done">
              <CheckIcon size={18} /> En la biblioteca
            </span>
          ) : (
            <button className="round" onClick={() => onImport(file)} disabled={importing} aria-label="Descargar a la biblioteca" title="Descargar a la biblioteca">
              {importing ? <span className="spinner" /> : <DownloadIcon />}
            </button>
          ))}
      </header>

      <div className="player-stage" onClick={isVideo ? togglePlay : undefined}>
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={file.path}
            className="player-media"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.01 }}
            transition={{ duration: 0.25 }}
          >
            {failed ? (
              <p className="hint">{failed}</p>
            ) : !src ? (
              <span className="spinner large" aria-label="Preparando vista previa" />
            ) : isVideo ? (
              <video
                // Al cambiar de archivo, el video anterior sale con una animación
                // después de que entra el nuevo: no debe borrar la referencia.
                ref={(el) => {
                  if (!el) return;
                  videoRef.current = el;
                  return () => {
                    el.pause();
                    if (videoRef.current === el) videoRef.current = null;
                  };
                }}
                key={src}
                src={src}
                autoPlay
                playsInline
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
                onError={onMediaError}
              />
            ) : (
              <img src={src} alt={file.name} onError={onMediaError} draggable={false} />
            )}
          </motion.div>
        </AnimatePresence>

        <AnimatePresence>
          {pulse && (
            <motion.span
              key={pulse.at}
              className="play-pulse"
              initial={{ opacity: 0.9, scale: 0.8 }}
              animate={{ opacity: 0, scale: 1.25 }}
              transition={{ duration: 0.5 }}
              onAnimationComplete={() => setPulse(null)}
            >
              {pulse.playing ? <PlayIcon size={34} /> : <PauseIcon size={34} />}
            </motion.span>
          )}
        </AnimatePresence>

        {index > 0 && (
          <button className="stage-nav left" onClick={(e) => (e.stopPropagation(), onMove(index - 1))} aria-label="Anterior">
            <ChevronLeftIcon />
          </button>
        )}
        {index < files.length - 1 && (
          <button className="stage-nav right" onClick={(e) => (e.stopPropagation(), onMove(index + 1))} aria-label="Siguiente">
            <ChevronRightIcon />
          </button>
        )}

        <AnimatePresence>
          {showInfo && (
            <motion.aside
              className="info-panel"
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ type: "spring", stiffness: 380, damping: 34 }}
            >
              <h3>{file.name}</h3>
              <dl>
                <dt>Grabado</dt>
                <dd>{formatDate(file.modifiedMs)}</dd>
                {duration != null && isVideo && (
                  <>
                    <dt>Duración</dt>
                    <dd>{formatDuration(duration)}</dd>
                  </>
                )}
                <dt>Tamaño</dt>
                <dd>{formatBytes(file.size)}</dd>
                {clipInfo && (
                  <>
                    <dt>Video</dt>
                    <dd>{describeClip(clipInfo)}</dd>
                  </>
                )}
                <dt>Ubicación</dt>
                <dd>{wireless ? "En la cámara" : imported && onImport ? "En la cámara y en la biblioteca" : "En la computadora"}</dd>
              </dl>
              {lowRes && <p className="hint small">Se ve la versión ligera que guarda la cámara; el original está en alta resolución.</p>}
            </motion.aside>
          )}
        </AnimatePresence>
      </div>

      <footer className="player-bottom">
        {isVideo && duration ? (
          <Filmstrip videoRef={videoRef} src={src} duration={duration} />
        ) : (
          <div className="filmstrip-spacer" />
        )}

        {onEdit && isVideo && (
          <nav className="tool-row" aria-label="Editar">
            {TOOLS.map((t) => (
              <button key={t.id} className="tool" onClick={() => onEdit(file, t.id)}>
                <t.icon size={26} />
                <span>{t.label}</span>
              </button>
            ))}
          </nav>
        )}

        <div className="player-controls">
          <button className="round ghost" disabled={index === 0} onClick={() => onMove(index - 1)} aria-label="Anterior">
            <ChevronLeftIcon />
          </button>
          {isVideo ? (
            <button className="round play" onClick={togglePlay} aria-label={playing ? "Pausa" : "Reproducir"}>
              {playing ? <PauseIcon size={26} /> : <PlayIcon size={26} />}
            </button>
          ) : (
            <span className="round play placeholder" />
          )}
          <button className="round ghost" disabled={index === files.length - 1} onClick={() => onMove(index + 1)} aria-label="Siguiente">
            <ChevronRightIcon />
          </button>
        </div>
      </footer>
    </motion.div>
  );
}
