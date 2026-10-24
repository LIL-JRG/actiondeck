import { useCallback, useEffect, useState } from "react";
import { api, errorText, type MediaFile, type Settings, type TimelineItem } from "./api";
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
