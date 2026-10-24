import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import type { MediaFile, NearbyCamera, TimelineItem } from "./api";
import { phaseProgress, type Camera } from "./camera";
import { CameraArt } from "./DeviceSheet";
import type { ToolId } from "./EditView";
import { formatBytes, formatDuration } from "./format";
import { AlbumIcon, ChevronRightIcon, ClapperIcon, LogIcon, VideoIcon, WifiIcon } from "./icons";
import { durationOf, type LocalMeta } from "./library";
import { Player } from "./Player";

type Props = {
  camera: Camera;
  library: MediaFile[];
  meta: LocalMeta;
  timeline: TimelineItem[];
  hasLut: boolean;
  onConnect: (camera: NearbyCamera) => void;
  onOpenDevice: () => void;
  onOpenLibrary: () => void;
  onOpenEditor: () => void;
  onOpenSettings: () => void;
  onEdit: (files: MediaFile[], tool: ToolId | null) => void;
};

const appear = (i: number) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.45, delay: 0.05 + i * 0.06, ease: [0.2, 0.8, 0.2, 1] as const },
});

export function HomeView({ camera, library, meta, timeline, hasLut, onConnect, onOpenDevice, onOpenLibrary, onOpenEditor, onOpenSettings, onEdit }: Props) {
  const { link, nearby, phase } = camera;
  const recent = useMemo(() => [...library].sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, 12), [library]);
  const [viewer, setViewer] = useState<number | null>(null);
  const videos = library.filter((f) => f.kind === "video");
  const librarySize = library.reduce((sum, f) => sum + f.size, 0);
  const projectLength = timeline.reduce((sum, t) => sum + (t.outPoint - t.inPoint) / t.speed, 0);

  const target = link.status !== "idle" ? link.camera : nearby.cameras[0];
  const view = link.status === "connecting" ? "connecting" : link.status === "connected" ? "connected" : target ? "found" : "searching";

  return (
    <div className="home">
      <header className="page-header">
        <h1 className="page-title">ActionDeck</h1>
      </header>

      <motion.section className="hero" {...appear(0)}>
        <div className="hero-text">
          <span className="eyebrow">
            {view === "connected" ? (
              <>
                <WifiIcon size={14} /> Conectada por Wi-Fi
              </>
            ) : view === "searching" ? (
              "Mi cámara"
            ) : (
              <>
                <span className="live-dot" /> Encendida cerca
              </>
            )}
          </span>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={view + (target?.id ?? "")} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }}>
              <h2 className="hero-title">{target ? target.model : "Enciende tu cámara"}</h2>
              <p className="hero-sub">
                {view === "searching"
                  ? (nearby.bluetoothError ?? "La detecto sola por Bluetooth en cuanto la enciendas, como Mimo.")
                  : view === "connecting"
                    ? phase || "Conectando…"
                    : view === "connected" && link.status === "connected"
                      ? `${link.files.length} archivos listos para ver y descargar`
                      : target?.name}
              </p>
              {view === "connecting" && (
                <div className="bar light">
                  <motion.div animate={{ width: `${phaseProgress(phase) * 100}%` }} transition={{ type: "spring", stiffness: 60, damping: 20 }} />
                </div>
              )}
              {view === "found" && target && (
                <button className="pill primary large" onClick={() => onConnect(target)}>
                  Conectar
                </button>
              )}
              {view === "connected" && (
                <button className="pill primary large" onClick={onOpenDevice}>
                  Ver archivos
                </button>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="hero-art">
          <CameraArt view={view} size={340} />
        </div>
      </motion.section>

      {!hasLut && (
        <motion.button className="banner" onClick={onOpenSettings} {...appear(1)}>
          <LogIcon size={26} />
          <span>
            <strong>Recupera el color de tus videos D-Log M</strong>
            <span className="hint small">Elige la LUT oficial de DJI una vez y se aplica al editar.</span>
          </span>
          <ChevronRightIcon size={20} />
        </motion.button>
      )}

      <motion.section className="home-cards" {...appear(2)}>
        <button className="home-card" onClick={onOpenLibrary}>
          <AlbumIcon size={26} />
          <strong>Biblioteca</strong>
          <span className="hint small">
            {videos.length} {videos.length === 1 ? "video" : "videos"} · {formatBytes(librarySize)}
          </span>
        </button>
        <button className="home-card" onClick={onOpenEditor}>
          <ClapperIcon size={26} />
          <strong>Proyecto</strong>
          <span className="hint small">
            {timeline.length === 0 ? "Empieza un video nuevo" : `${timeline.length} clips · ${formatDuration(projectLength)}`}
          </span>
        </button>
      </motion.section>

      {recent.length > 0 && (
        <motion.section className="recent" {...appear(3)}>
          <header className="section-head">
            <h3>Recientes</h3>
            <button className="link" onClick={onOpenLibrary}>
              Ver todo
            </button>
          </header>
          <ul className="recent-row">
            {recent.map((f, i) => {
              const duration = durationOf(f, meta);
              return (
                <li key={f.path}>
                  <button className="tile recent-tile" onClick={() => setViewer(i)} title={f.name}>
                    {meta.thumbs[f.path] ? <img src={meta.thumbs[f.path]} alt="" draggable={false} /> : <span className="tile-blank loading" />}
                    <span className="tile-scrim" />
                    {f.kind === "video" && (
                      <span className="tile-duration">
                        <VideoIcon size={16} /> {duration != null ? formatDuration(duration) : ""}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </motion.section>
      )}

      {createPortal(
        <AnimatePresence>
          {viewer !== null && recent[viewer] && (
            <Player
              key="player"
              files={recent}
              index={viewer}
              wireless={false}
              meta={meta}
              isImported={() => true}
              onMove={setViewer}
              onClose={() => setViewer(null)}
              onEdit={(f, tool) => {
                setViewer(null);
                onEdit([f], tool);
              }}
            />
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
