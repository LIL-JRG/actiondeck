import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, type PanInfo } from "motion/react";

type Props = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  label: string;
  className?: string;
  /** De abajo (se cierra arrastrándola hacia abajo) o de la derecha. */
  side?: "bottom" | "right";
  /** Clara como la hoja de conexión de Mimo, u oscura como el resto. */
  tone?: "light" | "dark";
};

const sheetSpring = { type: "spring", stiffness: 330, damping: 34, mass: 0.9 } as const;

/** Hoja que sube (o entra de lado) con un resorte, sobre un fondo que se oscurece. */
export function Sheet({ open, onClose, children, label, className = "", side = "bottom", tone = "dark" }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const hidden = side === "bottom" ? { y: "100%" } : { x: "100%" };
  const shown = side === "bottom" ? { y: 0 } : { x: 0 };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > 120 || info.velocity.y > 600) onClose();
  };

  // En la raíz del documento: por encima de la barra de abajo y de las páginas.
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className={`sheet-layer side-${side}`} role="dialog" aria-modal="true" aria-label={label}>
          <motion.div
            className="sheet-backdrop"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          />
          <motion.div
            className={`sheet sheet-${side} sheet-${tone} ${className}`}
            initial={hidden}
            animate={shown}
            exit={hidden}
            transition={sheetSpring}
            drag={side === "bottom" ? "y" : false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0.04, bottom: 0.7 }}
            dragSnapToOrigin
            onDragEnd={onDragEnd}
          >
            {side === "bottom" && <div className="sheet-grabber" />}
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
