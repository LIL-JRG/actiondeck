import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { DeviceFamily, NearbyCamera } from "./api";
import { needsApproval, phaseProgress, type Camera } from "./camera";
import { CheckIcon } from "./icons";
import { Sheet } from "./Sheet";

type Props = {
  open: boolean;
  onClose: () => void;
  camera: Camera;
  /** Ya conectada: ir a sus archivos. */
  onShowFiles: () => void;
};

export type View = "searching" | "found" | "connecting" | "approval" | "connected" | "failed";

/**
 * La hoja que sube sola cuando se enciende una cámara, como la de Mimo:
 * reconoce el modelo, ofrece conectarse y muestra cada paso hasta que sus
 * archivos están listos.
 */
export function DeviceSheet({ open, onClose, camera, onShowFiles }: Props) {
  const { link, nearby, arrived, phase } = camera;
  const target: NearbyCamera | null = link.status !== "idle" ? link.camera : (arrived ?? nearby.cameras[0] ?? null);
  const view: View =
    link.status === "connecting"
      ? needsApproval(phase)
        ? "approval"
        : "connecting"
      : link.status === "connected"
        ? "connected"
        : link.status === "failed"
          ? "failed"
          : target
            ? "found"
            : "searching";

  // Al conectarse con la hoja abierta, muestra el ✓ un momento y lleva a los archivos.
  const wasConnecting = useRef(false);
  useEffect(() => {
    if (view === "connecting" || view === "approval") wasConnecting.current = true;
    else if (view === "connected" && wasConnecting.current && open) {
      wasConnecting.current = false;
      const timer = window.setTimeout(onShowFiles, 1100);
      return () => window.clearTimeout(timer);
    } else wasConnecting.current = false;
  }, [view, open, onShowFiles]);

  const connect = () => target && camera.connect(target);
  const progress = view === "connected" ? 1 : phaseProgress(phase);

  const title = view === "searching" ? "Buscando cámaras" : target?.name;
  const status: Record<View, string> = {
    searching: nearby.bluetoothError ?? "Enciende tu cámara y acércala a la computadora.",
    found:
      target?.wifi === "unsupported"
        ? `La ${target.model} aún no se puede conectar por Wi-Fi`
        : `${target?.model ?? "Cámara"} encendida cerca`,
    connecting: phase || "Conectando…",
    approval: "Acepta la conexión en la pantalla de la cámara",
    connected: link.status === "connected" ? `Conectado · ${link.files.length} archivos en la cámara` : "Conectado",
    failed: link.status === "failed" ? link.error : "",
  };

  return (
    <Sheet open={open} onClose={onClose} tone="light" className="device-sheet" label="Cámara">
      <AnimatePresence mode="wait" initial={false}>
        <motion.h2
          key={title}
          className="device-title"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
        >
          {title}
        </motion.h2>
      </AnimatePresence>

      <div className="device-art">
        <CameraArt view={view} family={target?.family} />
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.p
          key={view + status[view]}
          className={view === "failed" ? "device-status error" : view === "approval" ? "device-status strong" : "device-status"}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
        >
          {status[view]}
          {view === "approval" && <span className="device-sub">Tienes unos 20 segundos</span>}
        </motion.p>
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {(view === "connecting" || view === "approval" || view === "connected") && (
          <motion.div
            className="device-bar"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 10 }}
            exit={{ opacity: 0, height: 0 }}
          >
            <motion.div
              className="device-bar-fill"
              initial={{ width: "4%" }}
              animate={{ width: `${progress * 100}%` }}
              transition={{ type: "spring", stiffness: 60, damping: 20 }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="device-actions">
        {view === "found" && target?.wifi === "unsupported" && (
          <>
            <p className="device-note">
              Conéctala por USB-C (modo de transferencia) o mete su microSD en un lector: sus archivos aparecen en Álbum ›
              Dispositivo.
            </p>
            <button className="pill dark large wide" onClick={onClose}>
              Entendido
            </button>
          </>
        )}
        {view === "found" && target?.wifi !== "unsupported" && (
          <>
            <button className="pill dark large wide" onClick={connect}>
              Conectar
            </button>
            <p className="device-note">
              {(target?.wifi === "untested" || target?.wifi == null) &&
                "Aún no se ha probado la conexión con este modelo, pero usa el mismo sistema que la Action 5 Pro. "}
              Para ver y bajar tus videos, la computadora se une a la red Wi-Fi de la cámara. Mientras tanto no tiene
              internet por Wi-Fi.
            </p>
            <button className="pill ghost-dark" onClick={onClose}>
              Ahora no
            </button>
          </>
        )}
        {(view === "connecting" || view === "approval") && (
          <button className="pill ghost-dark" onClick={onClose}>
            Seguir en segundo plano
          </button>
        )}
        {view === "connected" && (
          <>
            <button className="pill dark large wide" onClick={onShowFiles}>
              Ver archivos
            </button>
            <button className="pill ghost-dark" onClick={() => camera.disconnect()}>
              Desconectar
            </button>
          </>
        )}
        {view === "failed" && (
          <>
            <button className="pill dark large wide" onClick={connect}>
              Reintentar
            </button>
            <button
              className="pill ghost-dark"
              onClick={() => {
                camera.resetFailure();
                onClose();
              }}
            >
              Cerrar
            </button>
          </>
        )}
        {view === "searching" && (
          <>
            <p className="device-note">
              Se detecta sola por Bluetooth al encenderla. Si la conectas por USB-C, sus archivos aparecen en Álbum ›
              Dispositivo.
            </p>
            <button className="pill ghost-dark" onClick={onClose}>
              Cerrar
            </button>
          </>
        )}
      </div>
    </Sheet>
  );
}

/**
 * Una cámara de acción dibujada (no es la foto del producto): flota, emite
 * ondas mientras busca, arcos de Wi-Fi mientras se conecta y un ✓ al final.
 */
export function CameraArt({ view, family, size = 300 }: { view: View | "idle"; family?: DeviceFamily | null; size?: number }) {
  const on = view !== "searching" && view !== "idle";
  return (
    <div className="camera-art" style={{ width: size, height: size * 0.72 }}>
      {/* Las ondas se repiten sin fin; el contenedor es el que se desvanece al salir. */}
      <AnimatePresence>
        {view === "searching" && (
          <motion.div className="art-rings" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="art-ring"
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1.6, opacity: [0, 0.5, 0] }}
                transition={{ duration: 3, repeat: Infinity, delay: i, ease: "easeOut" }}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        className="art-float"
        animate={{ y: [0, -7, 0] }}
        transition={{ duration: 3.4, repeat: Infinity, ease: "easeInOut" }}
      >
        <svg viewBox="0 0 320 220" width="100%" height="100%" aria-hidden="true">
          <defs>
            <linearGradient id="art-body" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#4b4b4f" />
              <stop offset="0.5" stopColor="#2c2c30" />
              <stop offset="1" stopColor="#1b1b1e" />
            </linearGradient>
            <linearGradient id="art-screen" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#3d7bff" />
              <stop offset="1" stopColor="#0d2d77" />
            </linearGradient>
            <radialGradient id="art-glass" cx="0.38" cy="0.35" r="0.75">
              <stop offset="0" stopColor="#4a5568" />
              <stop offset="0.45" stopColor="#151a24" />
              <stop offset="1" stopColor="#030405" />
            </radialGradient>
            <filter id="art-soft" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="0.6" />
            </filter>
          </defs>

          {family === "pocket" ? (
            <PocketBody on={on} approval={view === "approval"} />
          ) : family === "pano" ? (
            <PanoBody on={on} approval={view === "approval"} />
          ) : (
            <ActionBody on={on} approval={view === "approval"} />
          )}
        </svg>

        <AnimatePresence>
          {(view === "connecting" || view === "approval") && (
            <motion.div className="art-wifi" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className={`arc arc-${i}`}
                  animate={{ opacity: [0.15, 1, 0.15] }}
                  transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.22 }}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {view === "connected" && (
            <motion.span
              className="art-check"
              initial={{ scale: 0, rotate: -30 }}
              animate={{ scale: 1, rotate: 0 }}
              exit={{ scale: 0 }}
              transition={{ type: "spring", stiffness: 480, damping: 20 }}
            >
              <CheckIcon size={26} strokeWidth={2.6} />
            </motion.span>
          )}
        </AnimatePresence>
      </motion.div>

      <motion.span
        className="art-shadow"
        animate={{ scaleX: [1, 0.86, 1], opacity: [0.5, 0.32, 0.5] }}
        transition={{ duration: 3.4, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}

type BodyProps = { on: boolean; approval: boolean };

/** Pantalla encendida (con datos de grabación) o pidiendo aceptar la conexión. */
function Screen({ x, y, w, h, on, approval }: BodyProps & { x: number; y: number; w: number; h: number }) {
  const small = Math.min(w, h);
  return (
    <>
      <rect x={x - 5} y={y - 5} width={w + 10} height={h + 10} rx={11} fill="#0b0b0d" />
      <motion.rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={7}
        fill={on ? "url(#art-screen)" : "#141418"}
        animate={approval ? { opacity: [1, 0.55, 1] } : { opacity: 1 }}
        transition={approval ? { duration: 1.1, repeat: Infinity } : { duration: 0.3 }}
      />
      {on && !approval && (
        <g fill="#fff" fontFamily="-apple-system, system-ui, sans-serif" fontWeight="600">
          <text x={x + 6} y={y + 12} fontSize="7" opacity="0.9">
            1h03m
          </text>
          <rect x={x + w - 17} y={y + 6} width="11" height="6" rx="1.5" fill="none" stroke="#fff" strokeWidth="1" />
          <rect x={x + w - 15.5} y={y + 7.5} width="6" height="3" rx="0.5" />
          <text x={x + 6} y={y + h - 7} fontSize="7" opacity="0.9">
            4K60
          </text>
          <circle cx={x + w - 11} cy={y + h - 9.5} r="3" fill="#ff453a" />
        </g>
      )}
      {approval && (
        <g stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <circle cx={x + w / 2} cy={y + h / 2} r={small * 0.24} strokeOpacity="0.9" />
          <path
            d={`m${x + w / 2 - small * 0.12} ${y + h / 2} ${small * 0.09} ${small * 0.09} ${small * 0.15} ${-small * 0.17}`}
          />
        </g>
      )}
    </>
  );
}

/** Lente con el anillo rojo de los Osmo. */
function Lens({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  const k = r / 44;
  return (
    <>
      <circle cx={cx} cy={cy} r={r} fill="#232326" />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#3b3b40" strokeWidth="2" />
      <circle cx={cx} cy={cy} r={37 * k} fill="#101012" />
      <circle cx={cx} cy={cy} r={32 * k} fill="none" stroke="#d6312b" strokeWidth="2.2" />
      <circle cx={cx} cy={cy} r={26 * k} fill="url(#art-glass)" />
      <ellipse
        cx={cx - 9 * k}
        cy={cy - 10 * k}
        rx={8 * k}
        ry={5 * k}
        fill="#fff"
        opacity="0.28"
        filter="url(#art-soft)"
        transform={`rotate(-30 ${cx - 9 * k} ${cy - 10 * k})`}
      />
      <circle cx={cx + 7 * k} cy={cy + 8 * k} r={2.2 * k} fill="#fff" opacity="0.18" />
    </>
  );
}

/** Cámara de acción (Action, Nano): cuerpo ancho, pantalla al frente y soportes. */
function ActionBody(props: BodyProps) {
  return (
    <>
      <path d="M78 82c-30 0-44 14-44 34s14 34 44 34" fill="none" stroke="#dedede" strokeWidth="14" strokeLinecap="round" />
      <path d="M242 82c30 0 44 14 44 34s-14 34-44 34" fill="none" stroke="#dedede" strokeWidth="14" strokeLinecap="round" />
      <rect x="66" y="46" width="188" height="132" rx="24" fill="url(#art-body)" />
      <rect x="66" y="46" width="188" height="132" rx="24" fill="none" stroke="#5c5c61" strokeOpacity="0.6" />
      <path d="M90 47h140" stroke="#8a8a90" strokeOpacity="0.5" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="226" y="40" width="20" height="7" rx="3.5" fill="#3a3a3e" />
      <rect x="70" y="160" width="180" height="16" rx="8" fill="#141416" opacity="0.7" />
      <Screen x={87} y={69} w={70} h={82} {...props} />
      <Lens cx={206} cy={108} r={44} />
    </>
  );
}

/** De mano con estabilizador (Pocket): mango alto, cabezal con la lente y pantalla. */
function PocketBody(props: BodyProps) {
  return (
    <>
      <rect x="128" y="64" width="64" height="152" rx="24" fill="url(#art-body)" />
      <rect x="128" y="64" width="64" height="152" rx="24" fill="none" stroke="#5c5c61" strokeOpacity="0.6" />
      <rect x="146" y="40" width="28" height="34" rx="8" fill="#26262a" />
      <rect x="114" y="6" width="92" height="58" rx="22" fill="url(#art-body)" />
      <rect x="114" y="6" width="92" height="58" rx="22" fill="none" stroke="#5c5c61" strokeOpacity="0.6" />
      <Lens cx={160} cy={35} r={24} />
      <Screen x={137} y={84} w={46} h={66} {...props} />
      <circle cx="160" cy="180" r="9" fill="#141416" stroke="#4a4a4f" />
      <circle cx="160" cy="180" r="3.5" fill="#d6312b" />
    </>
  );
}

/** Cámara 360: cuerpo alto con una lente abombada a cada lado. */
function PanoBody(props: BodyProps) {
  return (
    <>
      <rect x="112" y="14" width="96" height="200" rx="34" fill="url(#art-body)" />
      <rect x="112" y="14" width="96" height="200" rx="34" fill="none" stroke="#5c5c61" strokeOpacity="0.6" />
      <circle cx="160" cy="68" r="40" fill="#1b1b1e" />
      <Lens cx={160} cy={68} r={36} />
      <Screen x={134} y={124} w={52} h={56} {...props} />
      <rect x="146" y="194" width="28" height="6" rx="3" fill="#141416" />
    </>
  );
}
