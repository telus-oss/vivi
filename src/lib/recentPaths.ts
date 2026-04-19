export const RECENT_PATHS_KEY = "recent-repo-paths";
export const MAX_RECENT_PATHS = 5;

export function getRecentPaths(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_PATHS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveRecentPath(path: string) {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return;
  const paths = getRecentPaths().filter(p => p !== trimmed);
  paths.unshift(trimmed);
  localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(paths.slice(0, MAX_RECENT_PATHS)));
}
