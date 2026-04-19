export const PANEL_WIDTH_KEY = "panel-width";

export function getPanelWidth(): number {
  try {
    const v = localStorage.getItem(PANEL_WIDTH_KEY);
    if (!v) return 50;
    const parsed = parseFloat(v);
    return isNaN(parsed) ? 50 : parsed;
  } catch {
    return 50;
  }
}

export function savePanelWidth(width: number) {
  const clamped = clampWidth(width);
  localStorage.setItem(PANEL_WIDTH_KEY, String(clamped));
}

export function clampWidth(rawPct: number): number {
  return Math.min(80, Math.max(20, rawPct));
}
