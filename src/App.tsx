import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  errorText,
  onNearbyCameras,
  type MediaFile,
  type Nearby,
  type NearbyCamera,
  type Settings,
  type TimelineItem,
} from "./api";
import { EditView } from "./EditView";
import { ImportView } from "./ImportView";
import { SettingsView } from "./SettingsView";
import "./App.css";

type Tab = "import" | "edit" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "import", label: "Importar" },
  { id: "edit", label: "Editar y exportar" },
  { id: "settings", label: "Ajustes" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("import");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [library, setLibrary] = useState<MediaFile[]>([]);
  // La línea de tiempo vive aquí para no perderse al cambiar de pestaña.
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nearby, setNearby] = useState<Nearby>({ bluetoothError: null, cameras: [] });
  // Aviso de la cámara que se acaba de encender, como el de Mimo.
  const [arrived, setArrived] = useState<NearbyCamera | null>(null);
  const known = useRef<Set<string>>(new Set());

  useEffect(() => {
    const update = (next: Nearby) => {
      const fresh = next.cameras.find((c) => !known.current.has(c.id));
      known.current = new Set(next.cameras.map((c) => c.id));
      setNearby(next);
      // Si la cámara del aviso sigue cerca, se muestran sus datos más recientes.
      setArrived((shown) => fresh ?? next.cameras.find((c) => c.id === shown?.id) ?? null);
    };
    api.nearbyCameras().then(update).catch(() => {});
    const pending = onNearbyCameras(update);
    return () => {
      pending.then((unlisten) => unlisten());
    };
  }, []);

  const refreshLibrary = useCallback(() => {
    api.libraryFiles().then(setLibrary).catch((e) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    api.getSettings().then(setSettings).catch((e) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    if (settings) refreshLibrary();
  }, [settings?.libraryDir, refreshLibrary]);

  if (!settings) {
    return <div className="boot">{error ?? "Iniciando…"}</div>;
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">ActionDeck</span>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "tab active" : "tab"} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === "edit" && timeline.length > 0 && <span className="count">{timeline.length}</span>}
            </button>
          ))}
        </nav>
        <CameraStatus nearby={nearby} />
        {!settings.lutName && (
          <button className="link" onClick={() => setTab("settings")}>
            Falta elegir la LUT
          </button>
        )}
      </header>

      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button className="icon" onClick={() => setError(null)} aria-label="Cerrar">
            ×
          </button>
        </div>
      )}

      {arrived && (
        <div className="notice" role="status">
          <span>
            <strong>{arrived.model}</strong> encendida ({arrived.name}). Para pasar sus videos, conéctala por USB-C o
            mete la microSD; la transferencia por Wi-Fi llega en la siguiente etapa.
          </span>
          <button className="icon" onClick={() => setArrived(null)} aria-label="Cerrar">
            ×
          </button>
        </div>
      )}

      <main className="content">
        {tab === "import" && (
          <ImportView libraryDir={settings.libraryDir} libraryFiles={library} onImported={refreshLibrary} onError={setError} />
        )}
        {tab === "edit" && (
          <EditView settings={settings} library={library} timeline={timeline} setTimeline={setTimeline} onError={setError} />
        )}
        {tab === "settings" && <SettingsView settings={settings} onChange={setSettings} onError={setError} />}
      </main>
    </div>
  );
}

function CameraStatus({ nearby }: { nearby: Nearby }) {
  if (nearby.bluetoothError) {
    return (
      <span className="camera-status" title={nearby.bluetoothError}>
        <span className="dot" /> Bluetooth no disponible
      </span>
    );
  }
  const [first, ...rest] = nearby.cameras;
  if (!first) {
    return (
      <span className="camera-status" title="Enciende la cámara para que aparezca aquí">
        <span className="dot" /> Sin cámara encendida
      </span>
    );
  }
  return (
    <span className="camera-status on" title={nearby.cameras.map((c) => c.name).join(", ")}>
      <span className="dot" /> {first.model} encendida{rest.length > 0 && ` y ${rest.length} más`}
    </span>
  );
}
