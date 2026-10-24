import { useEffect, useRef, useState } from "react";
import { api, cameraUrl, errorText, fileUrl, type ClipInfo, type MediaFile } from "./api";

/** Lo que se sabe de un archivo local: su miniatura y, si es video, su análisis. */
export type LocalMeta = {
  /** URL lista para `<img>`; "" si no se pudo generar. */
  thumbs: Record<string, string>;
  /** Análisis de cada video, o el error si no se pudo leer. */
  infos: Record<string, ClipInfo | string>;
};

/**
 * Miniaturas y análisis de archivos en disco, de uno en uno para no saturar
 * el disco: primero las miniaturas (lo que se ve), luego el análisis. Los
 * resultados se conservan aunque cambie la lista.
 */
export function useLocalMeta(files: MediaFile[], analyze: boolean): LocalMeta {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [infos, setInfos] = useState<Record<string, ClipInfo | string>>({});
  const done = useRef({ thumbs: new Set<string>(), infos: new Set<string>() });

  useEffect(() => {
    let cancelled = false;
    // Lo más reciente primero: es lo que está arriba en la galería.
    const ordered = [...files].sort((a, b) => b.modifiedMs - a.modifiedMs);
    (async () => {
      for (const f of ordered) {
        if (cancelled) return;
        if (done.current.thumbs.has(f.path)) continue;
        let url = "";
        try {
          url = fileUrl(await api.thumbnail(f.path));
        } catch {
          // Sin miniatura el archivo sigue siendo usable.
        }
        if (cancelled) return;
        done.current.thumbs.add(f.path);
        setThumbs((prev) => ({ ...prev, [f.path]: url }));
      }
      if (!analyze) return;
      for (const f of ordered) {
        if (cancelled) return;
        if (f.kind !== "video" || done.current.infos.has(f.path)) continue;
        let info: ClipInfo | string;
        try {
          info = await api.probe(f.path);
        } catch (e) {
          info = errorText(e);
        }
        if (cancelled) return;
        done.current.infos.add(f.path);
        setInfos((prev) => ({ ...prev, [f.path]: info }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [files, analyze]);

  return { thumbs, infos };
}

/** Miniatura de un archivo: la de la cámara por Wi-Fi o la generada en disco. */
export function thumbOf(file: MediaFile, wireless: boolean, meta: LocalMeta | null): string | undefined {
  if (wireless) return file.thumb ? cameraUrl(file.thumb) : "";
  return meta?.thumbs[file.path];
}

/** Duración conocida de un archivo, por la cámara o por su análisis. */
export function durationOf(file: MediaFile, meta: LocalMeta | null): number | null {
  if (file.duration != null) return file.duration;
  const info = meta?.infos[file.path];
  return info && typeof info !== "string" ? info.duration : null;
}

/** Clave para saber si un archivo ya está en la biblioteca: mismo nombre y tamaño. */
export function importKey(f: MediaFile): string {
  return `${f.name.toLowerCase()}|${f.size}`;
}
