import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { motion } from "motion/react";
import type { Lut, View360 } from "./api";
import { loadLut, VideoRenderer } from "./gl";
import { PlusIcon } from "./icons";

/** "DJI OSMO Action 5 Pro Mei" → "Mei": el nombre del estilo sin la cámara. */
export function shortLutName(name: string): string {
  return name.replace(/^DJI OSMO (Action \d+( Pro)?|Pocket \d+( Pro)?|Nano|360) /i, "");
}

const ALL = "Todos";
const MINE = "Míos";
// Miniatura: 16:10, al doble para pantallas Retina.
const THUMB_W = 176;
const THUMB_H = 110;

type Props = {
  luts: Lut[];
  /** Filtro elegido (ID) y su intensidad (0–1). */
  value: string | null;
  strength: number;
  onChange: (id: string | null) => void;
  onStrength: (strength: number) => void;
  /** De dónde salen las miniaturas: el cuadro actual, con la LUT de conversión del clip. */
  videoRef: RefObject<HTMLVideoElement | null>;
  frameKey: string;
  conversion: string | null;
  view: View360 | null;
  /** Al final de la fila: conseguir más filtros. */
  onMore?: () => void;
  /** A la derecha de las categorías (p. ej. antes y después). */
  action?: ReactNode;
};

/**
 * Galería de filtros al estilo de Mimo: categorías, una fila de miniaturas del
 * cuadro actual con cada estilo y la intensidad del elegido.
 */
export function LookGallery({ luts, value, strength, onChange, onStrength, videoRef, frameKey, conversion, view, onMore, action }: Props) {
  const looks = useMemo(() => luts.filter((l) => l.kind !== "conversion"), [luts]);
  const categories = useMemo(() => {
    const names = [...new Set(looks.filter((l) => l.kind === "look").map((l) => l.category ?? ""))];
    return [ALL, ...names, ...(looks.some((l) => l.kind === "extra") ? [MINE] : [])];
  }, [looks]);
  const selected = looks.find((l) => l.id === value) ?? null;
  const [category, setCategory] = useState(() =>
    selected?.kind === "extra" ? MINE : (selected?.category ?? ALL),
  );
  const shown = looks.filter((l) =>
    category === ALL ? l.kind === "look" : category === MINE ? l.kind === "extra" : l.category === category,
  );
  const thumbs = useThumbs(videoRef, frameKey, conversion, view, [null, ...shown.map((l) => l.id)]);

  // El elegido, a la vista al abrir el panel o al cambiar de categoría.
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rowRef.current?.querySelector(".look-tile.on")?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [category]);

  const pick = (id: string | null) => {
    if (id === value) return;
    onChange(id);
    onStrength(1);
  };

  return (
    <div className="look-gallery">
      <div className="look-top">
        <div className="look-cats" role="tablist" aria-label="Categorías de filtros">
          {categories.map((c) => (
            <button key={c} role="tab" aria-selected={c === category} className={c === category ? "look-cat on" : "look-cat"} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </div>
        {action && <div className="look-action">{action}</div>}
      </div>

      <div className="look-row" ref={rowRef}>
        <Tile name="Ninguno" image={thumbs[""]} on={value === null} onClick={() => pick(null)} />
        {shown.map((l) => (
          <Tile
            key={l.id}
            name={l.kind === "extra" ? shortLutName(l.name) : l.name}
            title={l.detail}
            image={thumbs[l.id]}
            on={l.id === value}
            onClick={() => pick(l.id)}
          />
        ))}
        {onMore && (
          <button className="look-tile" onClick={onMore} title="Descargar los estilos de DJI o importar un .cube">
            <span className="look-thumb look-more">
              <PlusIcon size={22} />
            </span>
            <span className="look-name">Más</span>
          </button>
        )}
      </div>

      <div className="look-foot">
        {selected ? (
          <>
            <span className="look-detail" title={selected.detail}>
              {selected.kind === "extra" ? "Filtro importado" : selected.detail}
            </span>
            <label className="look-strength">
              <span>Intensidad</span>
              <input
                className="slider"
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(strength * 100)}
                onChange={(e) => onStrength(Number(e.target.value) / 100)}
                aria-label="Intensidad del filtro"
                style={{ ["--fill" as string]: `${strength * 100}%` }}
              />
              <span className="slider-value">{Math.round(strength * 100)}</span>
            </label>
          </>
        ) : (
          <span className="look-detail">Elige un estilo; luego ajusta su intensidad.</span>
        )}
      </div>
    </div>
  );
}

function Tile({ name, title, image, on, onClick }: { name: string; title?: string; image?: string; on: boolean; onClick: () => void }) {
  return (
    <button className={on ? "look-tile on" : "look-tile"} onClick={onClick} title={title} aria-pressed={on}>
      <span className="look-thumb">
        {image ? <img src={image} alt="" draggable={false} /> : <span className="look-thumb-empty" />}
        {on && <motion.span layoutId="look-ring" className="look-ring" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
      </span>
      <span className="look-name">{name}</span>
    </button>
  );
}

/**
 * Miniaturas del cuadro actual del video con cada filtro (clave "" = sin
 * filtro), hechas en la GPU. Se rehacen al pausar o mover el cabezal, no
 * mientras se reproduce.
 */
function useThumbs(
  videoRef: RefObject<HTMLVideoElement | null>,
  frameKey: string,
  conversion: string | null,
  view: View360 | null,
  ids: (string | null)[],
): Record<string, string> {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(0);
  const renderer = useRef<VideoRenderer | null>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let timer = 0;
    const bump = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setTick((n) => n + 1), 120);
    };
    const events = ["seeked", "pause", "loadeddata"];
    events.forEach((e) => v.addEventListener(e, bump));
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => v.removeEventListener(e, bump));
    };
  }, [videoRef, frameKey]);

  useEffect(
    () => () => {
      renderer.current?.dispose(true);
      renderer.current = null;
    },
    [],
  );

  const idsKey = ids.join("|");
  const viewKey = JSON.stringify(view);
  useEffect(() => {
    let cancelled = false;
    // Un momento de espera: arrastrar un 360 cambia la vista en cada movimiento.
    const timer = window.setTimeout(async () => {
      const v = videoRef.current;
      if (!v || v.readyState < 2 || !VideoRenderer.supported()) return;
      if (!renderer.current) {
        const canvas = document.createElement("canvas");
        canvas.width = THUMB_W;
        canvas.height = THUMB_H;
        try {
          renderer.current = new VideoRenderer(canvas);
        } catch {
          return;
        }
        renderer.current.fit = "cover";
      }
      const r = renderer.current;
      r.view = view;
      r.lookAmount = 1;
      const base = conversion ? await loadLut(conversion).catch(() => null) : null;
      for (const id of ids) {
        const look = id ? await loadLut(id).catch(() => null) : null;
        if (cancelled) return;
        r.setLut(0, base);
        r.setLut(1, look);
        if (!r.draw(v)) return;
        const url = r.canvas.toDataURL("image/jpeg", 0.85);
        setThumbs((prev) => ({ ...prev, [id ?? ""]: url }));
      }
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `ids` y `view` llegan como claves de texto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, idsKey, conversion, viewKey, frameKey, videoRef]);

  return thumbs;
}
