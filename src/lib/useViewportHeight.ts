import { useEffect, useState } from "react";

/**
 * Syncs a `--app-height` CSS custom property with the current visual viewport
 * height so the root layout shrinks when the iOS on-screen keyboard opens.
 *
 * Returns `keyboardOpen` — true when the visual viewport is noticeably smaller
 * than the layout viewport (heuristic: more than 120 px shorter than
 * `window.innerHeight`). Consumers use this to reveal the "tap to dismiss
 * keyboard" hint.
 */
export function useViewportHeight(): { keyboardOpen: boolean } {
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;

    const apply = () => {
      const height = vv?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--app-height", `${height}px`);
      const layoutHeight = window.innerHeight;
      setKeyboardOpen(layoutHeight - height > 120);
    };

    apply();

    if (vv) {
      vv.addEventListener("resize", apply);
      vv.addEventListener("scroll", apply);
    }
    window.addEventListener("orientationchange", apply);
    window.addEventListener("resize", apply);

    return () => {
      if (vv) {
        vv.removeEventListener("resize", apply);
        vv.removeEventListener("scroll", apply);
      }
      window.removeEventListener("orientationchange", apply);
      window.removeEventListener("resize", apply);
    };
  }, []);

  return { keyboardOpen };
}
