import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errorText, type CameraDrive, type MediaFile, type NearbyCamera } from "./api";
import { phaseProgress, type Camera, type Importer } from "./camera";
import { CameraArt } from "./DeviceSheet";
import type { ToolId } from "./EditView";
import { ChipGroup } from "./EditView";
import { dayKey, dayLabel, formatBytes, formatDate, formatDuration } from "./format";
import {
  CheckCircleIcon,
  CheckIcon,
  CloseIcon,
  DownloadIcon,
  FolderIcon,
  GridIcon,
  ListIcon,
  PlusIcon,
  UsbIcon,
  VideoIcon,
  WifiIcon,
} from "./icons";
import { durationOf, importKey, thumbOf, useLocalMeta, type LocalMeta } from "./library";
import { Player } from "./Player";

export type Scope = "device" | "local";
type Filter = "all" | "video" | "photo" | "new";
type ViewMode = "grid" | "list";

/** De dónde vienen los archivos de «Dispositivo». */
type Source = { kind: "wifi" } | { kind: "disk"; label: string; path: string; usb: boolean };

type Props = {
  library: MediaFile[];
  libraryMeta: LocalMeta;
  libraryDir: string;
  camera: Camera;
  importer: Importer;
  scope: Scope;
  setScope: (s: Scope) => void;
  onConnect: (camera: NearbyCamera) => void;
  onEdit: (files: MediaFile[], tool: ToolId | null) => void;
  onError: (message: string) => void;
};

const VIEW_KEY = "actiondeck.albumView";

function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
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

export function AlbumView({ library, libraryMeta, libraryDir, camera, importer, scope, setScope, onConnect, onEdit, onError }: Props) {
  const [drives, setDrives] = useState<CameraDrive[]>([]);
  const [disk, setDisk] = useState<Extract<Source, { kind: "disk" }> | null>(null);
  const [diskFiles, setDiskFiles] = useState<MediaFile[]>([]);
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [view, setView] = useViewMode();
  const [viewer, setViewer] = useState<{ files: MediaFile[]; index: number } | null>(null);

  const link = camera.link;
  const wifiFiles = link.status === "connected" ? link.files : null;
  // Por Wi-Fi tiene prioridad: es lo que se acaba de conectar.
  const source: Source | null = wifiFiles ? { kind: "wifi" } : disk;
  const wireless = source?.kind === "wifi";

  // La cámara puede conectarse por USB en cualquier momento: revisa las unidades cada 3 s.
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

  const scan = useCallback(
    async (next: Extract<Source, { kind: "disk" }>) => {
      setDisk(next);
      setScope("device");
      setScanning(true);
      setSelected(new Set());
      try {
        setDiskFiles(await api.scanFolder(next.path));
      } catch (e) {
        onError(errorText(e));
        setDiskFiles([]);
      } finally {
        setScanning(false);
      }
    },
    [onError, setScope],
  );

  const pickFolder = async () => {
    const path = await open({ directory: true, title: "Carpeta con videos de la cámara" });
    if (typeof path === "string") scan({ kind: "disk", label: path.split(/[\\/]/).pop() || path, path, usb: false });
  };

  const diskMeta = useLocalMeta(diskFiles, false);
  const meta: LocalMeta | null = scope === "local" ? libraryMeta : wireless ? null : diskMeta;

  const imported = useMemo(() => new Set(library.map(importKey)), [library]);
  const isImported = useCallback((f: MediaFile) => imported.has(importKey(f)), [imported]);

  const all: MediaFile[] = scope === "local" ? library : wireless ? (wifiFiles ?? []) : disk ? diskFiles : [];
  const files = useMemo(
    () =>
      all
        .filter((f) =>
          filter === "all" ? true : filter === "new" ? !isImported(f) : f.kind === filter,
        )
        .sort((a, b) => b.modifiedMs - a.modifiedMs),
    [all, filter, isImported],
  );

  // Al cambiar de origen, la selección ya no aplica.
  const sourceKey = scope === "local" ? "local" : wireless ? "wifi" : (disk?.path ?? "none");
  useEffect(() => {
    setSelected(new Set());
    setSelecting(false);
    setViewer(null);
    if (scope === "local" && filter === "new") setFilter("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  // Esc sale del modo de selección.
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !viewer) setSelecting(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, viewer]);

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const chosen = files.filter((f) => selected.has(f.path));
  const chosenBytes = chosen.reduce((sum, f) => sum + f.size, 0);

  const runImport = async (paths: string[]) => {
    const result = await importer.run(paths, wireless);
    if (!result) return;
    // Lo que ya se copió deja de estar seleccionado; solo queda lo que falló.
    const done = new Set([...result.copied, ...result.skipped]);
    setSelected((prev) => new Set([...prev].filter((p) => !done.has(p))));
    if (result.failed.length === 0 && !result.cancelled) setSelecting(false);
  };

  const groups = useMemo(() => {
    const out: { key: string; label: string; items: { file: MediaFile; index: number }[] }[] = [];
    files.forEach((file, index) => {
      const key = dayKey(file.modifiedMs);
      let group = out[out.length - 1];
      if (!group || group.key !== key) {
        group = { key, label: dayLabel(file.modifiedMs), items: [] };
        out.push(group);
      }
      group.items.push({ file, index });
    });
    return out;
  }, [files]);

  const showFiles = scope === "local" || !!source;
  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: "Todo" },
    { id: "video", label: "Videos" },
    { id: "photo", label: "Fotos" },
    ...(scope === "device" ? [{ id: "new" as Filter, label: "Sin importar" }] : []),
  ];

  return (
    <div className="album">
      <header className="page-header album-header">
        <div className="scope-tabs" role="tablist">
          {(["device", "local"] as Scope[]).map((s) => (
            <button key={s} role="tab" aria-selected={scope === s} className={scope === s ? "scope active" : "scope"} onClick={() => setScope(s)}>
              {s === "device" ? "Dispositivo" : "Local"}
              {s === "device" && (link.status === "connected" || disk) && <span className="scope-dot" />}
            </button>
          ))}
        </div>
        {showFiles && all.length > 0 && (
          <div className="row">
            <button
              className="round"
              onClick={() => setView(view === "grid" ? "list" : "grid")}
              aria-label={view === "grid" ? "Ver como lista" : "Ver como cuadrícula"}
              title={view === "grid" ? "Ver como lista" : "Ver como cuadrícula"}
            >
              {view === "grid" ? <ListIcon size={22} /> : <GridIcon size={22} />}
            </button>
            <button
              className={selecting ? "round on" : "round"}
              onClick={() => {
                setSelecting(!selecting);
                if (selecting) setSelected(new Set());
              }}
              aria-label="Seleccionar"
              title="Seleccionar"
            >
              <CheckCircleIcon size={24} />
            </button>
          </div>
        )}
      </header>

      {scope === "device" && (
        <SourceBar
          camera={camera}
          drives={drives}
          disk={disk}
          wireless={wireless}
          onScan={scan}
          onPickFolder={pickFolder}
          onCloseDisk={() => {
            setDisk(null);
            setDiskFiles([]);
          }}
          onConnect={onConnect}
        />
      )}

      {showFiles && all.length > 0 && (
        <div className="filter-row">
          <ChipGroup options={filters} value={filter} onChange={(v) => setFilter(v as Filter)} layoutId={`album-filter-${scope}`} />
          <span className="hint small">
            {files.length} {files.length === 1 ? "archivo" : "archivos"}
            {scope === "device" && ` · ${all.filter(isImported).length} ya en la biblioteca`}
          </span>
        </div>
      )}

      <div className="album-scroll">
        {scope === "device" && !source && <DeviceEmpty camera={camera} drives={drives} onConnect={onConnect} onScan={scan} onPickFolder={pickFolder} />}
        {scope === "device" && source?.kind === "disk" && scanning && (
          <div className="album-empty">
            <span className="spinner large" />
            <p className="hint">Buscando videos…</p>
          </div>
        )}
        {showFiles && !scanning && all.length === 0 && (
          <div className="album-empty">
            <p className="hint">
              {scope === "local" ? (
                <>
                  Tu biblioteca está vacía. Importa desde <strong>Dispositivo</strong>.
                  <br />
                  <span className="small mono">{libraryDir}</span>
                </>
              ) : (
                "No encontré videos ni fotos aquí."
              )}
            </p>
          </div>
        )}
        {showFiles && all.length > 0 && files.length === 0 && <p className="hint album-empty">Nada con este filtro.</p>}

        {groups.map((g) => (
          <section key={g.key} className="day">
            <h3 className="day-title">{g.label}</h3>
            {view === "grid" ? (
              <ul className="tiles">
                {g.items.map(({ file, index }) => (
                  <Tile
                    key={file.path}
                    file={file}
                    thumb={thumbOf(file, wireless && scope === "device", meta)}
                    duration={durationOf(file, meta)}
                    device={scope === "device"}
                    imported={isImported(file)}
                    selecting={selecting}
                    selected={selected.has(file.path)}
                    onClick={() => (selecting ? toggle(file.path) : setViewer({ files, index }))}
                  />
                ))}
              </ul>
            ) : (
              <ul className="rows">
                {g.items.map(({ file, index }) => (
                  <Row
                    key={file.path}
                    file={file}
                    thumb={thumbOf(file, wireless && scope === "device", meta)}
                    duration={durationOf(file, meta)}
                    device={scope === "device"}
                    imported={isImported(file)}
                    selecting={selecting}
                    selected={selected.has(file.path)}
                    onClick={() => (selecting ? toggle(file.path) : setViewer({ files, index }))}
                  />
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      <AnimatePresence>
        {selecting && !importer.running && (
          <motion.div
            className="action-bar"
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
          >
            <div className="action-text">
              <strong>{chosen.length === 0 ? "Elige archivos" : `${chosen.length} seleccionados`}</strong>
              <span className="hint small">{chosen.length > 0 ? formatBytes(chosenBytes) : "Toca las miniaturas"}</span>
            </div>
            <button className="link" onClick={() => setSelected(new Set(files.map((f) => f.path)))}>
              Todos
            </button>
            {scope === "device" && (
              <button className="link" onClick={() => setSelected(new Set(files.filter((f) => !isImported(f)).map((f) => f.path)))}>
                Solo nuevos
              </button>
            )}
            {scope === "device" ? (
              <button className="pill primary" disabled={chosen.length === 0} onClick={() => runImport(chosen.map((f) => f.path))}>
                <DownloadIcon size={18} /> Importar
              </button>
            ) : (
              <button
                className="pill primary"
                disabled={!chosen.some((f) => f.kind === "video")}
                onClick={() => {
                  onEdit(
                    chosen.filter((f) => f.kind === "video"),
                    null,
                  );
                  setSelecting(false);
                  setSelected(new Set());
                }}
              >
                <PlusIcon size={18} /> Al editor
              </button>
            )}
            <button className="round small" onClick={() => setSelecting(false)} aria-label="Salir de la selección">
              <CloseIcon size={18} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <ImportStatus importer={importer} />

      {createPortal(
        <AnimatePresence>
          {viewer && viewer.files[viewer.index] && (
            <Player
              key="player"
              files={viewer.files}
              index={viewer.index}
              wireless={wireless && scope === "device"}
              meta={meta}
              isImported={isImported}
              onMove={(index) => setViewer((v) => v && { ...v, index })}
              onClose={() => setViewer(null)}
              onImport={scope === "device" ? (f) => runImport([f.path]) : undefined}
              importing={importer.running}
              onEdit={
                scope === "local"
                  ? (f, tool) => {
                      setViewer(null);
                      onEdit([f], tool);
                    }
                  : undefined
              }
            />
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

/** Orígenes de «Dispositivo»: la cámara por Wi-Fi, unidades USB o una carpeta. */
function SourceBar({
  camera,
  drives,
  disk,
  wireless,
  onScan,
  onPickFolder,
  onCloseDisk,
  onConnect,
}: {
  camera: Camera;
  drives: CameraDrive[];
  disk: Extract<Source, { kind: "disk" }> | null;
  wireless: boolean;
  onScan: (s: Extract<Source, { kind: "disk" }>) => void;
  onPickFolder: () => void;
  onCloseDisk: () => void;
  onConnect: (camera: NearbyCamera) => void;
}) {
  const { link, nearby } = camera;
  if (!wireless && !disk) return null;
  return (
    <div className="source-bar">
      {link.status === "connected" ? (
        <span className={wireless ? "source-pill active" : "source-pill"}>
          <WifiIcon size={16} /> {link.camera.name}
        </span>
      ) : (
        nearby.cameras.map((c) => (
          <button key={c.id} className="source-pill" onClick={() => onConnect(c)} disabled={link.status === "connecting"}>
            <WifiIcon size={16} /> {c.name}
          </button>
        ))
      )}
      {drives.map((d) => (
        <button
          key={d.root}
          className={!wireless && disk?.path === d.dcim ? "source-pill active" : "source-pill"}
          onClick={() => onScan({ kind: "disk", label: d.label, path: d.dcim, usb: true })}
          disabled={wireless}
          title={wireless ? "Desconecta el Wi-Fi para ver la unidad" : d.root}
        >
          <UsbIcon size={16} /> {d.label}
        </button>
      ))}
      {disk && !disk.usb && !wireless && (
        <span className="source-pill active">
          <FolderIcon size={16} /> {disk.label}
        </span>
      )}
      {!wireless && (
        <button className="source-pill" onClick={onPickFolder}>
          <FolderIcon size={16} /> Elegir carpeta…
        </button>
      )}
      <span className="source-spacer" />
      {wireless ? (
        <>
          <span className="hint small">Sin internet por Wi-Fi mientras estás conectado</span>
          <button className="pill small" onClick={() => camera.disconnect()}>
            Desconectar
          </button>
        </>
      ) : (
        disk && (
          <button className="pill small" onClick={onCloseDisk}>
            Cerrar
          </button>
        )
      )}
    </div>
  );
}

/** «Dispositivo» sin nada abierto: la cámara cerca, las unidades y una carpeta. */
function DeviceEmpty({
  camera,
  drives,
  onConnect,
  onScan,
  onPickFolder,
}: {
  camera: Camera;
  drives: CameraDrive[];
  onConnect: (camera: NearbyCamera) => void;
  onScan: (s: Extract<Source, { kind: "disk" }>) => void;
  onPickFolder: () => void;
}) {
  const { link, nearby, phase } = camera;
  const target = link.status !== "idle" ? link.camera : nearby.cameras[0];
  const connecting = link.status === "connecting";
  return (
    <motion.div className="device-empty" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
      <div className="device-card">
        <CameraArt view={connecting ? "connecting" : target ? "found" : "searching"} size={260} />
        <div className="device-card-text">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={target ? target.id + link.status : "none"} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
              {connecting && target ? (
                <>
                  <h2>{target.name}</h2>
                  <p className="hint">{phase || "Conectando…"}</p>
                  <div className="bar">
                    <motion.div animate={{ width: `${phaseProgress(phase) * 100}%` }} transition={{ type: "spring", stiffness: 60, damping: 20 }} />
                  </div>
                </>
              ) : target ? (
                <>
                  <h2>{target.name}</h2>
                  <p className="hint">
                    {link.status === "failed" ? link.error : `${target.model} encendida cerca. Conéctate para ver sus videos sin sacar la microSD.`}
                  </p>
                  <button className="pill primary large" onClick={() => onConnect(target)}>
                    <WifiIcon size={20} /> {link.status === "failed" ? "Reintentar" : "Conectar"}
                  </button>
                </>
              ) : (
                <>
                  <h2>Ninguna cámara cerca</h2>
                  <p className="hint">{nearby.bluetoothError ?? "Enciende tu cámara: aparecerá aquí sola por Bluetooth."}</p>
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <div className="other-sources">
        <span className="hint small">O desde un cable o lector de microSD</span>
        <div className="row">
          {drives.map((d) => (
            <button key={d.root} className="source-card" onClick={() => onScan({ kind: "disk", label: d.label, path: d.dcim, usb: true })}>
              <UsbIcon size={22} />
              <span>
                <strong>{d.label}</strong>
                <span className="hint small">{d.removable ? "Unidad extraíble" : "Unidad"} · DCIM</span>
              </span>
            </button>
          ))}
          <button className="source-card" onClick={onPickFolder}>
            <FolderIcon size={22} />
            <span>
              <strong>Elegir carpeta…</strong>
              <span className="hint small">Una copia de la microSD</span>
            </span>
          </button>
        </div>
      </div>
    </motion.div>
  );
}

type TileProps = {
  file: MediaFile;
  thumb: string | undefined;
  duration: number | null;
  device: boolean;
  imported: boolean;
  selecting: boolean;
  selected: boolean;
  onClick: () => void;
};

function Tile({ file, thumb, duration, device, imported, selecting, selected, onClick }: TileProps) {
  return (
    <li>
      <button className={selected ? "tile selected" : "tile"} onClick={onClick} title={file.name}>
        {thumb ? <img src={thumb} alt="" loading="lazy" draggable={false} /> : <span className={thumb === "" ? "tile-blank" : "tile-blank loading"} />}
        <span className="tile-scrim" />
        {device && (
          <span className="tile-corner" title={imported ? "Ya está en la biblioteca" : "En la cámara"}>
            {imported ? <CheckIcon size={18} strokeWidth={2.2} /> : <DownloadIcon size={20} />}
          </span>
        )}
        {file.kind === "video" && (
          <span className="tile-duration">
            <VideoIcon size={16} /> {duration != null ? formatDuration(duration) : ""}
          </span>
        )}
        <AnimatePresence>
          {selecting && (
            <motion.span
              className={selected ? "select-dot on" : "select-dot"}
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.4, opacity: 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 28 }}
            >
              {selected && <CheckIcon size={14} strokeWidth={3} />}
            </motion.span>
          )}
        </AnimatePresence>
      </button>
    </li>
  );
}

function Row({ file, thumb, duration, device, imported, selecting, selected, onClick }: TileProps) {
  return (
    <li>
      <button className={selected ? "row-item selected" : "row-item"} onClick={onClick}>
        <span className="row-select">
          {selecting && <span className={selected ? "select-dot inline on" : "select-dot inline"}>{selected && <CheckIcon size={14} strokeWidth={3} />}</span>}
        </span>
        <span className="row-thumb">{thumb ? <img src={thumb} alt="" loading="lazy" draggable={false} /> : null}</span>
        <span className="row-name">{file.name}</span>
        <span className="row-meta">{file.kind === "video" ? (duration != null ? formatDuration(duration) : "Video") : "Foto"}</span>
        <span className="row-meta">{formatDate(file.modifiedMs)}</span>
        <span className="row-meta right">{formatBytes(file.size)}</span>
        <span className="row-state">{device && (imported ? <CheckIcon size={18} /> : <DownloadIcon size={18} />)}</span>
      </button>
    </li>
  );
}

/** Avance de la importación, flotando sobre la barra de abajo. */
function ImportStatus({ importer }: { importer: Importer }) {
  const { progress, running, summary } = importer;
  const percent = progress && progress.totalBytes > 0 ? (progress.copiedBytes / progress.totalBytes) * 100 : 0;

  useEffect(() => {
    if (!summary || summary.failed.length > 0) return;
    const timer = window.setTimeout(importer.dismiss, 5000);
    return () => window.clearTimeout(timer);
  }, [summary, importer.dismiss]);

  return (
    <AnimatePresence>
      {(running || summary) && (
        <motion.div
          className="import-status"
          initial={{ y: 40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 40, opacity: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
        >
          {running ? (
            <>
              <div className="import-line">
                <span className="spinner" />
                <span className="import-name">
                  {progress ? `${progress.fileIndex + 1} de ${progress.fileCount} · ${progress.fileName}` : "Preparando…"}
                </span>
                <span className="hint small">{progress ? `${formatBytes(progress.copiedBytes)} / ${formatBytes(progress.totalBytes)}` : ""}</span>
                <button className="pill small" onClick={() => importer.cancel()}>
                  Cancelar
                </button>
              </div>
              <div className="bar">
                <motion.div animate={{ width: `${percent}%` }} transition={{ ease: "easeOut", duration: 0.3 }} />
              </div>
            </>
          ) : (
            summary && (
              <div className="import-line">
                <span className="done-badge small">
                  <CheckIcon size={16} />
                </span>
                <span className="import-name">
                  {summary.cancelled ? "Importación cancelada. " : "Listo. "}
                  {summary.copied.length} copiados, {summary.skipped.length} ya estaban
                  {summary.failed.length > 0 && `, ${summary.failed.length} con error`}.
                  {summary.failed.map(([name, err]) => (
                    <span key={name} className="error-line">
                      {name}: {err}
                    </span>
                  ))}
                </span>
                <button className="round small" onClick={importer.dismiss} aria-label="Cerrar">
                  <CloseIcon size={16} />
                </button>
              </div>
            )
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
