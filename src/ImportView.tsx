import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  api,
  errorText,
  onImportProgress,
  onWirelessClosed,
  onWirelessPhase,
  type CameraDrive,
  type ImportProgress,
  type ImportSummary,
  type MediaFile,
  type NearbyCamera,
} from "./api";
import { formatBytes } from "./format";
import { MediaGrid, MediaList, PreviewModal, useViewMode, ViewToggle } from "./MediaBrowser";

type Props = {
  libraryDir: string;
  libraryFiles: MediaFile[];
  /** Cámaras encendidas cerca: se pueden importar por Wi-Fi. */
  nearby: NearbyCamera[];
  onImported: () => void;
  onError: (message: string) => void;
};

type Source = { label: string; path: string; wireless?: boolean };

export function ImportView({ libraryDir, libraryFiles, nearby, onImported, onError }: Props) {
  const [drives, setDrives] = useState<CameraDrive[]>([]);
  const [source, setSource] = useState<Source | null>(null);
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  // Por Wi-Fi: el paso en curso y si la computadora está en la red de la cámara.
  const [phase, setPhase] = useState("");
  const [onCameraWifi, setOnCameraWifi] = useState(false);
  const [view, setView] = useViewMode();
  const [previewing, setPreviewing] = useState<number | null>(null);

  // Al salir de la red de la cámara (desconectar, apagarla, terminar de
  // importar) sus archivos ya no se pueden ver ni bajar: el panel vuelve a
  // su estado inicial. El resumen de la importación sigue a la vista.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  useEffect(() => {
    const closed = () => {
      setOnCameraWifi(false);
      if (sourceRef.current?.wireless) {
        setSource(null);
        setFiles([]);
        setSelected(new Set());
        setPreviewing(null);
      }
    };
    const pending = [onWirelessPhase(setPhase), onWirelessClosed(closed)];
    return () => {
      pending.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []);

  // La cámara puede conectarse en cualquier momento: revisa las unidades cada 3 s.
  useEffect(() => {
    let alive = true;
    const poll = () =>
      api
        .cameraDrives()
        .then((d) => alive && setDrives(d))
        .catch(() => {});
    poll();
    const timer = window.setInterval(poll, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const pending = onImportProgress(setProgress);
    return () => {
      pending.then((unlisten) => unlisten());
    };
  }, []);

  // Un archivo con el mismo nombre y tamaño en la biblioteca ya está importado.
  const imported = useMemo(
    () => new Set(libraryFiles.map((f) => `${f.name.toLowerCase()}|${f.size}`)),
    [libraryFiles],
  );
  const isImported = useCallback((f: MediaFile) => imported.has(`${f.name.toLowerCase()}|${f.size}`), [imported]);

  const scan = useCallback(
    async (next: Source) => {
      setPreviewing(null);
      setSource(next);
      setSummary(null);
      setScanning(true);
      try {
        const found = await api.scanFolder(next.path);
        setFiles(found);
        // Nada seleccionado: el usuario elige qué importar.
        setSelected(new Set());
      } catch (e) {
        onError(errorText(e));
        setFiles([]);
      } finally {
        setScanning(false);
      }
    },
    [onError],
  );

  const connectWireless = async (camera: NearbyCamera) => {
    setPreviewing(null);
    setSource({ label: camera.name, path: `wifi:${camera.id}`, wireless: true });
    setSummary(null);
    setFiles([]);
    setScanning(true);
    try {
      const found = await api.wirelessConnect();
      setOnCameraWifi(true);
      setFiles(found);
      setSelected(new Set());
    } catch (e) {
      onError(errorText(e));
      setSource(null);
    } finally {
      setScanning(false);
    }
  };

  const pickFolder = async () => {
    const path = await open({ directory: true, title: "Carpeta con videos de la cámara" });
    if (typeof path === "string") scan({ label: path, path });
  };

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const chosen = files.filter((f) => selected.has(f.path));
  const chosenBytes = chosen.reduce((sum, f) => sum + f.size, 0);

  const runImport = async () => {
    setImporting(true);
    setSummary(null);
    setProgress(null);
    try {
      const paths = chosen.map((f) => f.path);
      const result = source?.wireless ? await api.wirelessImport(paths) : await api.startImport(paths);
      setSummary(result);
      // Lo que ya se copió deja de estar seleccionado; solo queda lo que falló.
      const done = new Set([...result.copied, ...result.skipped]);
      setSelected((prev) => new Set([...prev].filter((p) => !done.has(p))));
      onImported();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setImporting(false);
    }
  };

  const percent = progress && progress.totalBytes > 0 ? (progress.copiedBytes / progress.totalBytes) * 100 : 0;

  return (
    <div className="import-view">
      <aside className="panel sources">
        <h2>Origen</h2>
        {nearby.length > 0 && (
          <ul className="source-list">
            {nearby.map((camera) => (
              <li key={camera.id}>
                <button
                  className={source?.path === `wifi:${camera.id}` ? "source active" : "source"}
                  onClick={() => connectWireless(camera)}
                  disabled={scanning || importing}
                >
                  <span className="source-name">{camera.name}</span>
                  <span className="source-meta">Por Wi-Fi · {camera.model}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {drives.length === 0 ? (
          <p className="hint">
            {nearby.length > 0
              ? "O conéctala por USB-C, o mete la microSD en un lector, para copiar más rápido."
              : "Enciende la cámara para importar por Wi-Fi, o conéctala por USB-C (modo de transferencia de archivos) o mete la microSD en un lector. Aparecerá aquí sola."}
          </p>
        ) : (
          <ul className="source-list">
            {drives.map((d) => (
              <li key={d.root}>
                <button
                  className={source?.path === d.dcim ? "source active" : "source"}
                  onClick={() => scan({ label: d.label, path: d.dcim })}
                >
                  <span className="source-name">{d.label}</span>
                  <span className="source-meta">{d.removable ? "Unidad extraíble" : "Unidad"} · DCIM</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <button className="secondary" onClick={pickFolder}>
          Elegir carpeta…
        </button>
        <p className="hint small">
          Se copia a <span className="mono">{libraryDir}</span>, en carpetas por fecha.
        </p>
      </aside>

      <section className="panel files">
        <header className="files-header">
          <div>
            <h2>{source ? source.label : "Archivos"}</h2>
            {source && !scanning && (
              <p className="hint small">
                {files.length} archivos · {files.filter(isImported).length} ya en la biblioteca
              </p>
            )}
          </div>
          {files.length > 0 && (
            <div className="row">
              <ViewToggle mode={view} onChange={setView} />
              <button className="link" onClick={() => setSelected(new Set(files.map((f) => f.path)))}>
                Todos
              </button>
              <button className="link" onClick={() => setSelected(new Set(files.filter((f) => !isImported(f)).map((f) => f.path)))}>
                Solo nuevos
              </button>
              <button className="link" onClick={() => setSelected(new Set())}>
                Ninguno
              </button>
            </div>
          )}
        </header>

        {source?.wireless && onCameraWifi && !importing && (
          <div className="wifi-banner">
            <span>
              Conectado a la red de la cámara: la computadora no tiene internet por Wi-Fi mientras tanto. Se
              desconecta sola al terminar de importar.
            </span>
            <button className="link" onClick={() => api.wirelessDisconnect()}>
              Desconectar
            </button>
          </div>
        )}
        {scanning && <p className="hint">{source?.wireless ? phase || "Conectando…" : "Buscando videos…"}</p>}
        {!scanning && source && files.length === 0 && <p className="hint">No encontré videos ni fotos aquí.</p>}
        {!source && <p className="hint">Elige un origen a la izquierda.</p>}

        {files.length > 0 &&
          (view === "grid" ? (
            <MediaGrid
              files={files}
              wireless={!!source?.wireless}
              selected={selected}
              isImported={isImported}
              onToggle={toggle}
              onPreview={setPreviewing}
            />
          ) : (
            <MediaList
              files={files}
              wireless={!!source?.wireless}
              selected={selected}
              isImported={isImported}
              onToggle={toggle}
              onPreview={setPreviewing}
            />
          ))}
        {files.length === 0 && <div className="files-spacer" />}

        {previewing !== null && files[previewing] && (
          <PreviewModal
            files={files}
            index={previewing}
            wireless={!!source?.wireless}
            selected={selected}
            isImported={isImported}
            onToggle={toggle}
            onMove={setPreviewing}
            onClose={() => setPreviewing(null)}
          />
        )}

        <footer className="files-footer">
          {importing && progress ? (
            <div className="progress-block">
              <div className="progress-label">
                <span>
                  {progress.fileIndex + 1} de {progress.fileCount}: {progress.fileName}
                </span>
                <span>
                  {formatBytes(progress.copiedBytes)} / {formatBytes(progress.totalBytes)}
                </span>
              </div>
              <div className="progress">
                <div style={{ width: `${percent}%` }} />
              </div>
            </div>
          ) : phase && !scanning ? (
            <p className="hint">{phase}</p>
          ) : summary ? (
            <p className="hint">
              {summary.cancelled ? "Importación cancelada. " : "Listo. "}
              {summary.copied.length} copiados, {summary.skipped.length} ya estaban
              {summary.failed.length > 0 && `, ${summary.failed.length} con error`}.
              {summary.failed.map(([name, err]) => (
                <span key={name} className="error-line">
                  {name}: {err}
                </span>
              ))}
            </p>
          ) : (
            <p className="hint">
              {chosen.length} seleccionados · {formatBytes(chosenBytes)}
            </p>
          )}
          {importing ? (
            <button className="secondary" onClick={() => api.cancelImport()}>
              Cancelar
            </button>
          ) : (
            <button className="primary" disabled={chosen.length === 0} onClick={runImport}>
              Importar {chosen.length > 0 ? chosen.length : ""}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
