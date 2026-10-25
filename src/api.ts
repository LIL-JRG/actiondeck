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
  /** Cámara que lo grabó ("Osmo Action 5 Pro"), según sus metadatos. */
  device: string | null;
  /** Perfil de color con el que se grabó, de los metadatos de DJI. */
  colorMode: ColorMode | null;
  /** LUT oficial que lo lleva a Rec.709, si se grabó en un perfil logarítmico. */
  suggestedLut: string | null;
  /** Video 360 (una pista por lente); `width`×`height` es la vista 16:9 que se saca. */
  pano: boolean;
};

/** Vista de un video 360 (grados); misma forma que `View360` de gl.ts y render.rs. */
export type View360 = { yaw: number; pitch: number; roll: number; fov: number; mode: "flat" | "planet" };

export type ColorMode = "normal" | "d-cinelike" | "d-log" | "d-log-m" | "d-log2" | "hlg";

export const COLOR_MODE_NAMES: Record<ColorMode, string> = {
  normal: "Normal",
  "d-cinelike": "D-Cinelike",
  "d-log": "D-Log",
  "d-log-m": "D-Log M",
  "d-log2": "D-Log2",
  hlg: "HLG",
};

/** Una LUT: las oficiales de DJI vienen con la app; las extra las agrega el usuario. */
export type Lut = { id: string; name: string; detail: string; builtin: boolean };

/** Paquete de estilos creativos de DJI para descargar. */
export type LutPack = { id: string; name: string; installed: boolean };

export type CameraDrive = { root: string; dcim: string; label: string; removable: boolean };

export type Hardware = { encoder: Encoder; h264: boolean; hevc: boolean };

export type Settings = {
  libraryDir: string;
  ffmpegDir: string | null;
  ffmpegError: string | null;
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
  /** LUT que convierte el perfil de la cámara a Rec.709 (ID de `Lut`), o null. */
  lut: string | null;
  /** Estilo creativo que se aplica después (una LUT extra), o null. */
  look: string | null;
  hasAudio: boolean;
  /** 1 = normal, 0.25 = cuatro veces más lento. */
  speed: number;
  /** 0 = sin sonido, 1 = original, 2 = el doble. */
  volume: number;
  /** Qué parte de la imagen queda al recortar (0 izquierda/arriba, 1 derecha/abajo). */
  cropX: number;
  cropY: number;
  /** Solo en videos 360: hacia dónde mira el clip. */
  view: View360 | null;
  info: ClipInfo;
};

/** Cómo cabe un clip en otro formato: recortando o con barras negras. */
export type Fit = "crop" | "pad";

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
  fit: Fit;
};

export type ExportProgress = { secondsDone: number; secondsTotal: number; speed: string | null };

/** Qué tan probada está la conexión por Wi-Fi de un modelo. */
export type WifiSupport = "tested" | "compatible" | "untested" | "unsupported";

/** Forma de la cámara: de acción, de mano con estabilizador o 360. */
export type DeviceFamily = "action" | "pocket" | "pano";

export type NearbyCamera = { id: string; name: string; model: string; family: DeviceFamily | null; wifi: WifiSupport | null };

/** Cámaras encendidas cerca, detectadas por Bluetooth. */
export type Nearby = { bluetoothError: string | null; cameras: NearbyCamera[] };

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  setLibraryDir: (path: string) => invoke<Settings>("set_library_dir", { path }),
  setFfmpegDir: (path: string | null) => invoke<Settings>("set_ffmpeg_dir", { path }),
  listLuts: () => invoke<Lut[]>("list_luts"),
  importLut: (path: string) => invoke<Lut[]>("import_lut", { path }),
  removeLut: (id: string) => invoke<Lut[]>("remove_lut", { id }),
  lutPacks: () => invoke<LutPack[]>("lut_packs"),
  /** Descarga un paquete de estilos de DJI y devuelve todas las LUT. */
  downloadLutPack: (id: string) => invoke<Lut[]>("download_lut_pack", { id }),
  cameraDrives: () => invoke<CameraDrive[]>("list_camera_drives"),
  scanFolder: (path: string) => invoke<MediaFile[]>("scan_folder", { path }),
  libraryFiles: () => invoke<MediaFile[]>("library_files"),
  probe: (path: string) => invoke<ClipInfo>("probe_clip", { path }),
  startImport: (paths: string[]) => invoke<ImportSummary>("start_import", { paths }),
  cancelImport: () => invoke<void>("cancel_import"),
  thumbnail: (path: string) => invoke<string>("thumbnail", { path }),
  compareFrames: (path: string, at: number, lut: string | null, look: string | null, view: View360 | null) =>
    invoke<{ before: string; after: string | null }>("compare_frames", { path, at, lut, look, view }),
  /** El texto `.cube` de una LUT, para aplicarla en la GPU. */
  lutFile: (id: string) => invoke<ArrayBuffer>("lut_file", { id }),
  previewSource: (path: string, forceProxy = false) => invoke<string>("preview_source", { path, forceProxy }),
  startExport: (items: TimelineItem[], settings: ExportSettings) =>
    invoke<string>("start_export", {
      items: items.map(({ path, inPoint, outPoint, lut, look, hasAudio, speed, volume, cropX, cropY, view }) => ({
        path,
        inPoint,
        outPoint,
        lut,
        look,
        hasAudio,
        speed,
        volume,
        cropX,
        cropY,
        view,
      })),
      settings,
    }),
  cancelExport: () => invoke<boolean>("cancel_export"),
  nearbyCameras: () => invoke<Nearby>("nearby_cameras"),
  /** Despierta la cámara, se une a su Wi-Fi y devuelve sus archivos. */
  wirelessConnect: () => invoke<MediaFile[]>("wireless_connect"),
  /** Descarga a la biblioteca; la cámara sigue conectada hasta desconectar o quedar inactiva. */
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

/** Video 360 de la Osmo 360 (se sabe por la extensión, sin analizarlo). */
export function isPanoFile(f: { name: string }): boolean {
  return /\.osv$/i.test(f.name);
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function errorText(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : JSON.stringify(error);
}
