import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type MediaFile = {
  path: string;
  name: string;
  kind: "video" | "photo";
  size: number;
  modifiedMs: number;
  /** Versión ligera para la vista previa: un `.LRF` local o, por Wi-Fi, su ruta en la cámara. */
  proxyPath: string | null;
  /** Por Wi-Fi: ruta de la miniatura en la cámara. */
  thumb: string | null;
  /** Segundos, cuando se saben sin analizar el archivo (por Wi-Fi). */
  duration: number | null;
};

export type ClipInfo = {
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  pixFmt: string;
  bitDepth: number;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  hasAudio: boolean;
  creationTime: string | null;
  browserPlayable: boolean;
};

export type CameraDrive = { root: string; dcim: string; label: string; removable: boolean };

export type Hardware = { encoder: Encoder; h264: boolean; hevc: boolean };

export type Settings = {
  libraryDir: string;
  ffmpegDir: string | null;
  ffmpegError: string | null;
  lutName: string | null;
  lutSize: number | null;
  /** null si ffmpeg no está disponible. */
  hardware: Hardware | null;
  platform: "windows" | "macos" | "linux" | string;
};

/** Nombre visible del codificador de hardware de esta plataforma. */
export function hardwareName(encoder: Encoder): string {
  return encoder === "videotoolbox" ? "Apple VideoToolbox" : encoder === "nvenc" ? "GPU NVIDIA" : "Procesador";
}

export type ImportProgress = {
  fileIndex: number;
  fileCount: number;
  fileName: string;
  copiedBytes: number;
  totalBytes: number;
};

export type ImportSummary = {
  copied: string[];
  skipped: string[];
  failed: [string, string][];
  cancelled: boolean;
};

export type TimelineItem = {
  id: string;
  path: string;
  name: string;
  inPoint: number;
  outPoint: number;
  applyLut: boolean;
  hasAudio: boolean;
  info: ClipInfo;
};

export type Codec = "h264" | "hevc";
export type Encoder = "cpu" | "nvenc" | "videotoolbox";

export type ExportSettings = {
  output: string;
  codec: Codec;
  encoder: Encoder;
  quality: number;
  width: number;
  height: number;
  fps: number;
};

export type ExportProgress = { secondsDone: number; secondsTotal: number; speed: string | null };

export type NearbyCamera = { id: string; name: string; model: string };

/** Cámaras encendidas cerca, detectadas por Bluetooth. */
export type Nearby = { bluetoothError: string | null; cameras: NearbyCamera[] };

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  setLibraryDir: (path: string) => invoke<Settings>("set_library_dir", { path }),
  setFfmpegDir: (path: string | null) => invoke<Settings>("set_ffmpeg_dir", { path }),
  setLut: (path: string) => invoke<Settings>("set_lut", { path }),
  clearLut: () => invoke<Settings>("clear_lut"),
  cameraDrives: () => invoke<CameraDrive[]>("list_camera_drives"),
  scanFolder: (path: string) => invoke<MediaFile[]>("scan_folder", { path }),
  libraryFiles: () => invoke<MediaFile[]>("library_files"),
  probe: (path: string) => invoke<ClipInfo>("probe_clip", { path }),
  startImport: (paths: string[]) => invoke<ImportSummary>("start_import", { paths }),
  cancelImport: () => invoke<void>("cancel_import"),
  thumbnail: (path: string) => invoke<string>("thumbnail", { path }),
  compareFrames: (path: string, at: number) =>
    invoke<{ before: string; after: string | null }>("compare_frames", { path, at }),
  previewSource: (path: string, forceProxy = false) => invoke<string>("preview_source", { path, forceProxy }),
  startExport: (items: TimelineItem[], settings: ExportSettings) =>
    invoke<string>("start_export", {
      items: items.map(({ path, inPoint, outPoint, applyLut, hasAudio }) => ({
        path,
        inPoint,
        outPoint,
        applyLut,
        hasAudio,
      })),
      settings,
    }),
  cancelExport: () => invoke<boolean>("cancel_export"),
  nearbyCameras: () => invoke<Nearby>("nearby_cameras"),
  /** Despierta la cámara, se une a su Wi-Fi y devuelve sus archivos. */
  wirelessConnect: () => invoke<MediaFile[]>("wireless_connect"),
  /** Descarga a la biblioteca y vuelve a la red anterior. */
  wirelessImport: (paths: string[]) => invoke<ImportSummary>("wireless_import", { paths }),
  wirelessDisconnect: () => invoke<void>("wireless_disconnect"),
};

/** Paso de la conexión por Wi-Fi ("" cuando no hay nada en curso). */
export function onWirelessPhase(handler: (text: string) => void): Promise<UnlistenFn> {
  return listen<string>("wireless-phase", (e) => handler(e.payload));
}

/** La app salió de la red de la cámara (al terminar o por inactividad). */
export function onWirelessClosed(handler: () => void): Promise<UnlistenFn> {
  return listen("wireless-closed", () => handler());
}

export function onNearbyCameras(handler: (n: Nearby) => void): Promise<UnlistenFn> {
  return listen<Nearby>("nearby-cameras", (e) => handler(e.payload));
}

export function onImportProgress(handler: (p: ImportProgress) => void): Promise<UnlistenFn> {
  return listen<ImportProgress>("import-progress", (e) => handler(e.payload));
}

export function onExportProgress(handler: (p: ExportProgress) => void): Promise<UnlistenFn> {
  return listen<ExportProgress>("export-progress", (e) => handler(e.payload));
}

/** URL para mostrar un archivo local en `<img>` o `<video>`. */
export function fileUrl(path: string, bust?: number): string {
  const url = convertFileSrc(path);
  return bust ? `${url}?v=${bust}` : url;
}

/** URL de un archivo de la cámara (`0/DCIM/…`) mientras la app está en su red. */
export function cameraUrl(remotePath: string): string {
  return convertFileSrc(remotePath, "camara");
}

/** Une partes de una ruta con el separador que ya usa `base` (\ o /). */
export function joinPath(base: string, ...parts: string[]): string {
  const sep = base.includes("\\") ? "\\" : "/";
  return [base.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function errorText(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : JSON.stringify(error);
}
