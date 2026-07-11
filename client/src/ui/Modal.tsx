/**
 * Modal — confirmations and reveals (mockups.css §12).
 *
 * Accessibility contract:
 *  - role="dialog" + aria-modal, labelled by its title
 *  - focus is trapped inside while open; Tab/Shift+Tab cycle
 *  - Escape closes (unless `dismissable={false}`), clicking the scrim closes
 *  - modals may nest (e.g. a ConfirmModal atop a host dialog); Escape and the
 *    focus trap apply to the TOPMOST open modal only
 *  - focus returns to the previously-focused element on close
 *
 * ConfirmModal is the destructive-confirmation variant: title, one line of
 * consequence, a danger button with the verb, and "Think Again" to stay the
 * hand (design contract: destructive actions ALWAYS confirm via .modal).
 */
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  /** Visible small-caps dialog title (also the aria label). */
  title: string;
  onClose: () => void;
  /** Set false to remove Escape/scrim dismissal (e.g. forced battle modal). */
  dismissable?: boolean;
  /** Wider dialog (52rem) for ledgers/auctions. */
  wide?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Modal(props: ModalProps): JSX.Element {
  const { title, onClose, dismissable = true, wide, className, children } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<Element | null>(null);

  // Live refs so the keydown listener (registered once, on mount) always sees
  // the latest props without re-subscribing.
  const dismissableRef = useRef(dismissable);
  const onCloseRef = useRef(onClose);
  dismissableRef.current = dismissable;
  onCloseRef.current = onClose;

  // Trap focus, handle Escape (topmost modal only), restore focus on unmount.
  useEffect(() => {
    restoreRef.current = document.activeElement;
    const dialog = dialogRef.current;
    if (dialog) {
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? dialog).focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      // Only the TOPMOST open modal handles keys: every Modal registers a
      // document-level keydown listener, and `stopPropagation` cannot silence
      // sibling listeners on the same node — without this guard an Escape
      // meant for a nested confirm would also dismiss its host dialog, and
      // two focus traps would contend for Tab. "Topmost" is read from the
      // DOM: all Modals portal a .modal-scrim into <body>, so the LAST scrim
      // in document order is the one visually on top (a mount-order stack
      // would get this wrong — child effects run before parent effects).
      const scrims = document.querySelectorAll(".modal-scrim");
      if (scrims[scrims.length - 1] !== scrimRef.current) return;
      if (e.key === "Escape" && dismissableRef.current) {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const restore = restoreRef.current;
      if (restore instanceof HTMLElement) restore.focus();
    };
  }, []);

  return createPortal(
    <div
      ref={scrimRef}
      className="modal-scrim"
      onMouseDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={["modal", wide ? "modal--wide" : "", className ?? ""]
          .filter(Boolean)
          .join(" ")}
      >
        <h2 className="modal-title">{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmModalProps {
  title: string;
  /** One line of consequence, in voice. */
  consequence: string;
  /** The destructive verb, in voice (e.g. "Break Faith", "Yield the Floor"). */
  confirmLabel: string;
  /** Cancel label; defaults to the contract's "Think Again". */
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Destructive-confirmation modal per the design contract. */
export function ConfirmModal(props: ConfirmModalProps): JSX.Element {
  const {
    title,
    consequence,
    confirmLabel,
    cancelLabel = "Think Again",
    onConfirm,
    onCancel,
  } = props;
  return (
    <Modal title={title} onClose={onCancel}>
      <p>{consequence}</p>
      <div className="modal-actions">
        <Button variant="quiet" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant="danger" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
