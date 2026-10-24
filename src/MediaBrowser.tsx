import { useEffect, useState } from "react";
import { api, cameraUrl, fileUrl, type MediaFile } from "./api";
import { formatBytes, formatDate, formatDuration } from "./format";

export type ViewMode = "grid" | "list";

const VIEW_KEY = "actiondeck.importView";

/** Vista elegida la última vez (cuadrícula si no hay o el navegador no deja leerla). */
export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const choose = (next: ViewMode) => {
    setMode(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Sin almacenamiento solo se pierde la preferencia.
    }
  };
  return [mode, choose];
}

export function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Vista">
      <button className={mode === "grid" ? "active" : ""} onClick={() => onChange("grid")} aria-pressed={mode === "grid"}>
        Cuadrícula
      </button>
      <button className={mode === "list" ? "active" : ""} onClick={() => onChange("list")} aria-pressed={mode === "list"}>
        Lista
      </button>
    </div>
  );
}

type Shared = {
  files: MediaFile[];
  /** Los archivos están en la cámara (por Wi-Fi), no en el disco. */
  wireless: boolean;
  selected: Set<string>;
  isImported: (f: MediaFile) => boolean;
  onToggle: (path: string) => void;
  onPreview: (index: number) => void;
};

/**
 * Miniatura de cada archivo. Las de la cámara ya vienen hechas; las de una
 * carpeta local se generan con ffmpeg, de una en una para no saturar el disco.
 */
function useThumbnails(files: MediaFile[], wireless: boolean): Record<string, string> {
  const [local, setLocal] = useState<Record<string, string>>({});
  useEffect(() => {
    if (wireless) return;
    let cancelled = false;
    (async () => {
      for (const f of files) {
        if (cancelled) return;
        if (f.path in local) continue;
        try {
          const thumb = await api.thumbnail(f.path);
          if (!cancelled) setLocal((prev) => ({ ...prev, [f.path]: fileUrl(thumb) }));
        } catch {
          if (!cancelled) setLocal((prev) => ({ ...prev, [f.path]: "" }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Solo cuando cambia la lista de archivos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, wireless]);

  if (!wireless) return local;
  const remote: Record<string, string> = {};
  for (const f of files) if (f.thumb) remote[f.path] = cameraUrl(f.thumb);
  return remote;
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function MediaGrid({ files, wireless, selected, isImported, onToggle, onPreview }: Shared) {
  const thumbs = useThumbnails(files, wireless);
  return (
    <ul className="media-grid">
      {files.map((f, i) => {
        const isSelected = selected.has(f.path);
        const thumb = thumbs[f.path];
        return (
          <li
            key={f.path}
            className={isSelected ? "card selected" : "card"}
            onClick={() => onToggle(f.path)}
            onDoubleClick={() => onPreview(i)}
            title={f.name}
          >
            <div className="card-thumb">
              {thumb ? (
                <img src={thumb} alt="" loading="lazy" draggable={false} />
              ) : (
                <span className="card-placeholder">{thumb === "" ? "Sin miniatura" : f.kind === "video" ? "Video" : "Foto"}</span>
              )}
              <input className="card-check" type="checkbox" checked={isSelected} readOnly tabIndex={-1} />
              {isImported(f) && <span className="badge done card-imported">Importado</span>}
              {f.duration != null && <span className="card-duration">{formatDuration(f.duration)}</span>}
              <button
                className="card-preview"
                onClick={(e) => {
                  e.stopPropagation();
                  onPreview(i);
                }}
                aria-label={`Ver ${f.name}`}
              >
                {f.kind === "video" ? <PlayIcon /> : <ExpandIcon />}
              </button>
            </div>
            <div className="card-text">
              <span className="card-name">{f.name}</span>
              <span className="card-meta">
                {formatDate(f.modifiedMs)} · {formatBytes(f.size)}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function MediaList({ files, selected, isImported, onToggle, onPreview }: Shared) {
  return (
    <ul className="file-list">
      {files.map((f, i) => (
        <li key={f.path} className={selected.has(f.path) ? "file selected" : "file"} onClick={() => onToggle(f.path)}>
          <input type="checkbox" checked={selected.has(f.path)} readOnly tabIndex={-1} />
          <span className="file-name">{f.name}</span>
          <span className="badge">{f.kind === "video" ? "Video" : "Foto"}</span>
          {isImported(f) ? <span className="badge done">Importado</span> : <span />}
          <span className="file-meta right">{f.duration != null ? formatDuration(f.duration) : ""}</span>
          <span className="file-meta">{formatDate(f.modifiedMs)}</span>
          <span className="file-meta right">{formatBytes(f.size)}</span>
          <button
            className="icon"
            onClick={(e) => {
              e.stopPropagation();
              onPreview(i);
            }}
            aria-label={`Ver ${f.name}`}
          >
            {f.kind === "video" ? <PlayIcon /> : <ExpandIcon />}
          </button>
        </li>
      ))}
    </ul>
  );
}

type PreviewProps = {
  files: MediaFile[];
  index: number;
  wireless: boolean;
  selected: Set<string>;
  isImported: (f: MediaFile) => boolean;
  onToggle: (path: string) => void;
  onMove: (index: number) => void;
  onClose: () => void;
};

/**
 * Vista previa a pantalla completa. Por Wi-Fi, el video es la versión ligera
 * `.LRF` que se reproduce directo de la cámara (sin descargarlo) y la foto es
 * su miniatura grande; en una carpeta local, el `.LRF` si existe o una copia
 * ligera hecha con ffmpeg.
 */
export function PreviewModal({ files, index, wireless, selected, isImported, onToggle, onMove, onClose }: PreviewProps) {
  const file = files[index];
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [triedFallback, setTriedFallback] = useState(false);

  useEffect(() => {
    setFailed(null);
    setTriedFallback(false);
    if (wireless) {
      const remote = file.kind === "video" ? file.proxyPath : file.thumb;
      setSrc(remote ? cameraUrl(remote) : null);
      if (!remote) setFailed("La cámara no tiene vista previa de este archivo.");
    } else if (file.kind === "photo") {
      setSrc(fileUrl(file.path));
    } else {
      setSrc(file.proxyPath ? fileUrl(file.proxyPath) : null);
      if (!file.proxyPath) loadLocalPreview();
    }
    // Solo al cambiar de archivo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);

  const loadLocalPreview = () => {
    setTriedFallback(true);
    setSrc(null);
    api
      .previewSource(file.path)
      .then((p) => setSrc(fileUrl(p)))
      .catch(() => setFailed("No se pudo preparar la vista previa."));
  };

  const onMediaError = () => {
    if (!wireless && !triedFallback && file.kind === "video") loadLocalPreview();
    else setFailed(wireless ? "No se pudo reproducir la vista previa desde la cámara." : "No se pudo mostrar este archivo.");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      // Las flechas dentro del reproductor adelantan el video; fuera, cambian de archivo.
      else if ((e.target as HTMLElement)?.tagName === "VIDEO") return;
      else if (e.key === "ArrowLeft" && index > 0) onMove(index - 1);
      else if (e.key === "ArrowRight" && index < files.length - 1) onMove(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, files.length, onClose, onMove]);

  const isSelected = selected.has(file.path);

  return (
    <div className="preview-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={file.name}>
      <div className="preview" onClick={(e) => e.stopPropagation()}>
        <header className="preview-header">
          <div>
            <h2>{file.name}</h2>
            <p className="hint small">
              {formatDate(file.modifiedMs)}
              {file.duration != null && ` · ${formatDuration(file.duration)}`} · {formatBytes(file.size)}
              {wireless && file.kind === "video" && " · vista previa ligera desde la cámara"}
            </p>
          </div>
          <button className="icon" onClick={onClose} aria-label="Cerrar">
            ×
          </button>
        </header>

        <div className="preview-stage">
          {failed ? (
            <p className="hint">{failed}</p>
          ) : !src ? (
            <p className="hint">Preparando vista previa…</p>
          ) : file.kind === "video" ? (
            <video key={src} src={src} controls autoPlay playsInline onError={onMediaError} />
          ) : (
            <img src={src} alt={file.name} onError={onMediaError} />
          )}
        </div>

        <footer className="preview-footer">
          <button className="secondary" disabled={index === 0} onClick={() => onMove(index - 1)}>
            ‹ Anterior
          </button>
          <span className="hint small">
            {index + 1} de {files.length}
            {isImported(file) && " · ya está en la biblioteca"}
          </span>
          <div className="row">
            <button className={isSelected ? "secondary" : "primary"} onClick={() => onToggle(file.path)}>
              {isSelected ? "Quitar de la selección" : "Seleccionar para importar"}
            </button>
            <button className="secondary" disabled={index === files.length - 1} onClick={() => onMove(index + 1)}>
              Siguiente ›
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
