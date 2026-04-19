export const RENAME_TIP_KEY = "seen-rename-tip";

export function hasSeenRenameTip(): boolean {
  return !!localStorage.getItem(RENAME_TIP_KEY);
}

export function markRenameTipSeen(): void {
  localStorage.setItem(RENAME_TIP_KEY, "1");
}

export function shouldShowRenameTip(sessionCount: number): boolean {
  return sessionCount > 0 && !hasSeenRenameTip();
}
