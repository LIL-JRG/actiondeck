import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { api, errorText, type Lut, type MediaFile, type NearbyCamera, type Settings, type TimelineItem } from "./api";
import { AlbumView, type Scope } from "./AlbumView";
import { useCamera, useImporter } from "./camera";
import { DeviceSheet } from "./DeviceSheet";
import { EditView, type EditRequest, type ToolId } from "./EditView";
import { HomeView } from "./HomeView";
import { AlbumIcon, CameraIcon, ClapperIcon, CloseIcon, HomeIcon, SettingsIcon } from "./icons";
import { useLocalMeta } from "./library";
import { SettingsView } from "./SettingsView";
import "./App.css";

type Tab = "home" | "album" | "edit" | "settings";

const TABS: { id: Tab; label: string; icon: typeof HomeIcon }[] = [
  { id: "home", label: "Inicio", icon: HomeIcon },
  { id: "album", label: "Álbum", icon: AlbumIcon },
  { id: "edit", label: "Editor", icon: ClapperIcon },
  { id: "settings", label: "Ajustes", icon: SettingsIcon },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [scope, setScope] = useState<Scope>("device");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [library, setLibrary] = useState<MediaFile[]>([]);
  // El proyecto vive aquí para no perderse al cambiar de pantalla.
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [editRequest, setEditRequest] = useState<EditRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // LUT oficiales (vienen con la app) y extra; las usan el editor y los ajustes.
  const [luts, setLuts] = useState<Lut[]>([]);
  const clearError = useCallback(() => setError(null), []);

  const camera = useCamera();
  const refreshLibrary = useCallback(() => {
    api.libraryFiles().then(setLibrary).catch((e) => setError(errorText(e)));
  }, []);
  const importer = useImporter(refreshLibrary, setError);
  const libraryMeta = useLocalMeta(library, true);

  useEffect(() => {
    api.getSettings().then(setSettings).catch((e) => setError(errorText(e)));
    api.listLuts().then(setLuts).catch((e) => setError(errorText(e)));
  }, []);

  // En macOS el contenido sube bajo la barra de título transparente.
  useEffect(() => {
    if (settings) document.documentElement.dataset.platform = settings.platform;
  }, [settings?.platform]);

  useEffect(() => {
    if (settings) refreshLibrary();
  }, [settings?.libraryDir, refreshLibrary]);

  // Como Mimo: al encender una cámara, la hoja de conexión sube sola.
  useEffect(() => {
    if (camera.arrived && camera.link.status === "idle") setSheetOpen(true);
    // Solo cuando llega una cámara nueva.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.arrived]);

  const closeSheet = useCallback(() => {
    setSheetOpen(false);
    camera.forgetArrival();
  }, [camera.forgetArrival]);

  const showDeviceFiles = useCallback(() => {
    closeSheet();
    setScope("device");
    setTab("album");
  }, [closeSheet]);

  const connect = (target: NearbyCamera) => {
    setSheetOpen(true);
    camera.connect(target);
  };

  const edit = (files: MediaFile[], tool: ToolId | null) => {
    if (files.length === 0) return;
    setEditRequest({ paths: files.map((f) => f.path), tool, nonce: Date.now() });
    setTab("edit");
  };

  if (!settings) {
    return <div className="boot">{error ?? <span className="spinner large" />}</div>;
  }


  return (
    <MotionConfig reducedMotion="user">
      <div className="app">
        <div className="titlebar-space" data-tauri-drag-region />

        <main className="pages">
          <Page active={tab === "home"}>
            <HomeView
              camera={camera}
              library={library}
              meta={libraryMeta}
              timeline={timeline}
              onConnect={connect}
              onOpenDevice={showDeviceFiles}
              onOpenLibrary={() => {
                setScope("local");
                setTab("album");
              }}
              onOpenEditor={() => setTab("edit")}
              onEdit={edit}
            />
          </Page>
          <Page active={tab === "album"} className="page-album">
            <AlbumView
              library={library}
              libraryMeta={libraryMeta}
              libraryDir={settings.libraryDir}
              camera={camera}
              importer={importer}
              scope={scope}
              setScope={setScope}
              onConnect={connect}
              onEdit={edit}
              onError={setError}
            />
          </Page>
          <Page active={tab === "edit"} className="page-edit">
            <EditView
              active={tab === "edit"}
              settings={settings}
              luts={luts}
              library={library}
              meta={libraryMeta}
              timeline={timeline}
              setTimeline={setTimeline}
              request={editRequest}
              onGoSettings={() => setTab("settings")}
              onError={setError}
            />
          </Page>
          <Page active={tab === "settings"}>
            <SettingsView settings={settings} onChange={setSettings} luts={luts} onLutsChange={setLuts} onError={setError} />
          </Page>
        </main>

        <Dock tab={tab} setTab={setTab} clips={timeline.length} camera={camera} onCamera={() => setSheetOpen(true)} />

        <DeviceSheet open={sheetOpen} onClose={closeSheet} camera={camera} onShowFiles={showDeviceFiles} />

        <AnimatePresence>
          {error && <Toast key={error} message={error} onClose={clearError} />}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}

/**
 * Las pantallas siguen montadas al cambiar de pestaña (no se pierde lo que
 * estaba abierto); la activa aparece con un desvanecido.
 */
function Page({ active, className = "", children }: { active: boolean; className?: string; children: ReactNode }) {
  return (
    <motion.section
      className={`page ${className}`}
      aria-hidden={!active}
      initial={false}
      animate={active ? { opacity: 1, y: 0, visibility: "visible" } : { opacity: 0, y: 6, transitionEnd: { visibility: "hidden" } }}
      transition={{ duration: active ? 0.28 : 0.12, ease: [0.2, 0.8, 0.2, 1] }}
      style={{ pointerEvents: active ? "auto" : "none", zIndex: active ? 1 : 0 }}
    >
      {children}
    </motion.section>
  );
}

/** Barra flotante de Mimo: secciones a la izquierda y la cámara en el botón redondo. */
function Dock({
  tab,
  setTab,
  clips,
  camera,
  onCamera,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  clips: number;
  camera: ReturnType<typeof useCamera>;
  onCamera: () => void;
}) {
  const { link, nearby } = camera;
  const state =
    link.status === "connected" ? "connected" : link.status === "connecting" ? "connecting" : nearby.cameras.length > 0 ? "nearby" : "none";
  const cameraLabel = {
    connected: `Conectada: ${link.status === "connected" ? link.camera.name : ""}`,
    connecting: "Conectando con la cámara…",
    nearby: `${nearby.cameras[0]?.name ?? "Cámara"} encendida cerca`,
    none: nearby.bluetoothError ?? "Ninguna cámara cerca",
  }[state];

  return (
    <nav className="dock" aria-label="Secciones">
      <div className="dock-pill">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "dock-btn active" : "dock-btn"}
            onClick={() => setTab(t.id)}
            aria-label={t.label}
            aria-current={tab === t.id ? "page" : undefined}
          >
            {tab === t.id && <motion.span layoutId="dock-active" className="dock-active" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
            <t.icon size={26} />
            {t.id === "edit" && clips > 0 && <span className="dock-count">{clips}</span>}
            <span className="dock-tip">{t.label}</span>
          </button>
        ))}
      </div>
      <motion.button className={`dock-camera ${state}`} onClick={onCamera} aria-label={cameraLabel} whileTap={{ scale: 0.92 }}>
        <CameraIcon size={28} />
        {state === "connecting" && <span className="dock-ring" />}
        <AnimatePresence>
          {(state === "nearby" || state === "connected") && (
            <motion.span
              className="dock-badge"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 22 }}
            />
          )}
        </AnimatePresence>
        <span className="dock-tip">{cameraLabel}</span>
      </motion.button>
    </nav>
  );
}

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 8000);
    return () => window.clearTimeout(timer);
  }, [message, onClose]);
  return (
    <motion.div
      className="toast"
      role="alert"
      initial={{ opacity: 0, y: -16, x: "-50%", scale: 0.96 }}
      animate={{ opacity: 1, y: 0, x: "-50%", scale: 1 }}
      exit={{ opacity: 0, y: -16, x: "-50%", scale: 0.96 }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
    >
      <span className="toast-dot" />
      <span className="toast-text">{message}</span>
      <button className="round small" onClick={onClose} aria-label="Cerrar">
        <CloseIcon size={16} />
      </button>
    </motion.div>
  );
}
