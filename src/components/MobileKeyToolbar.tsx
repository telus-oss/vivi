import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";

/**
 * Thin toolbar of terminal-control keys that virtual keyboards don't provide
 * (ESC, TAB, arrows, common Ctrl shortcuts). Rendered only on small screens
 * while the on-screen keyboard is open and a terminal PTY is attached.
 *
 * The active Terminal component registers a `window.__viviSendKey` hook; this
 * component invokes it with the right escape sequence for each button. That
 * indirection keeps the toolbar decoupled from the Terminal's WebSocket state
 * and means swapping sessions doesn't require re-wiring the toolbar.
 */

declare global {
  interface Window {
    __viviSendKey?: (data: string) => void;
  }
}

function send(seq: string) {
  window.__viviSendKey?.(seq);
}

interface KeyButtonProps {
  label: React.ReactNode;
  title: string;
  onPress: () => void;
  wide?: boolean;
}

function KeyButton({ label, title, onPress, wide }: KeyButtonProps) {
  return (
    <button
      type="button"
      title={title}
      // Use pointerDown (not click) so a single tap registers even when the
      // terminal's hidden input swallows focus mid-press.
      onPointerDown={(e) => {
        e.preventDefault();
        onPress();
      }}
      className={`shrink-0 ${wide ? "px-3" : "px-2.5"} h-9 flex items-center justify-center rounded-md bg-[var(--color-surface-raised)] border border-[var(--color-border)] text-gray-200 text-xs font-mono active:bg-[var(--color-accent-muted)] active:text-white transition-colors`}
    >
      {label}
    </button>
  );
}

export function MobileKeyToolbar() {
  return (
    <div
      className="flex items-center gap-1.5 px-2 py-1.5 bg-[var(--color-surface)] border-t border-[var(--color-border)] overflow-x-auto"
      // Prevent the toolbar itself from stealing focus — tapping a button
      // should not blur the terminal's hidden input.
      onPointerDown={(e) => e.preventDefault()}
    >
      <KeyButton label="Esc" title="Escape" onPress={() => send("\x1b")} wide />
      <KeyButton label="Tab" title="Tab" onPress={() => send("\t")} wide />
      <KeyButton label={<ArrowUp className="w-3.5 h-3.5" />} title="Up" onPress={() => send("\x1b[A")} />
      <KeyButton label={<ArrowDown className="w-3.5 h-3.5" />} title="Down" onPress={() => send("\x1b[B")} />
      <KeyButton label={<ArrowLeft className="w-3.5 h-3.5" />} title="Left" onPress={() => send("\x1b[D")} />
      <KeyButton label={<ArrowRight className="w-3.5 h-3.5" />} title="Right" onPress={() => send("\x1b[C")} />
      <span className="w-px h-5 bg-[var(--color-border)] mx-1 shrink-0" />
      <KeyButton label="^C" title="Ctrl+C (interrupt)" onPress={() => send("\x03")} />
      <KeyButton label="^D" title="Ctrl+D (EOF)" onPress={() => send("\x04")} />
      <KeyButton label="^R" title="Ctrl+R (history search)" onPress={() => send("\x12")} />
      <KeyButton label="^L" title="Ctrl+L (clear screen)" onPress={() => send("\x0c")} />
    </div>
  );
}
