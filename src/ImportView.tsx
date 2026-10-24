import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  api,
  errorText,
  onImportProgress,
  type CameraDrive,
  type ImportProgress,
  type ImportSummary,
  type MediaFile,
} from "./api";
import { formatBytes, formatDate } from "./format";

type Props = {
  libraryDir: string;
  libraryFiles: MediaFile[];
  onImported: () => void;
  onError: (message: string) => void;
};

type Source = { label: string; path: string };

export function ImportView({ libraryDir, libraryFiles, onImported, onError }: Props) {
  const [drives, setDrives] = useState<CameraDrive[]>([]);
  const [source, setSource] = useState<Source | null>(null);
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

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
      setSource(next);
      setSummary(null);
      setScanning(true);
      try {
        const found = await api.scanFolder(next.path);
        setFiles(found);
        setSelected(new Set(found.filter((f) => !isImported(f)).map((f) => f.path)));
      } catch (e) {
        onError(errorText(e));
        setFiles([]);
      } finally {
        setScanning(false);
      }
    },
    [isImported, onError],
  );

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
      const result = await api.startImport(chosen.map((f) => f.path));
      setSummary(result);
      // Lo que ya se copió deja de estar seleccionado; solo queda lo que falló.
      const done = new Set([...result.copied, ...result.skipped].map((p) => p.split("\\").pop()!.toLowerCase()));
      setSelected((prev) => new Set([...prev].filter((p) => !done.has(p.split("\\").pop()!.toLowerCase()))));
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
        {drives.length === 0 ? (
          <p className="hint">
            Conecta la Osmo Action por USB-C (en la cámara, elige el modo de transferencia de archivos) o mete la
            microSD en un lector. Aparecerá aquí sola.
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

        {scanning && <p className="hint">Buscando videos…</p>}
        {!scanning && source && files.length === 0 && <p className="hint">No encontré videos ni fotos aquí.</p>}
        {!source && <p className="hint">Elige un origen a la izquierda.</p>}

        <ul className="file-list">
          {files.map((f) => (
            <li key={f.path} className={selected.has(f.path) ? "file selected" : "file"} onClick={() => toggle(f.path)}>
              <input type="checkbox" checked={selected.has(f.path)} readOnly tabIndex={-1} />
              <span className="file-name">{f.name}</span>
              <span className="badge">{f.kind === "video" ? "Video" : "Foto"}</span>
              {isImported(f) && <span className="badge done">Importado</span>}
              <span className="file-meta">{formatDate(f.modifiedMs)}</span>
              <span className="file-meta right">{formatBytes(f.size)}</span>
            </li>
          ))}
        </ul>

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
