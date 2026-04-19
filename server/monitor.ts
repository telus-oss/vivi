/**
 * Activity monitor — analyzes Claude's terminal output to detect:
 *   1. Repeated identical or similar commands (stuck loop)
 *   2. Repetitive/looping messages (similarity scoring)
 *   3. Long-running bash commands without prior "long task" indication
 *   4. Overall progress health (read/write vs bash ratio)
 *
 * The monitor ingests raw PTY output and parses Claude Code's structured
 * output patterns to extract tool usage events.
 */

export interface ToolEvent {
  timestamp: number;
  type: "bash" | "read" | "write" | "edit" | "glob" | "grep" | "other";
  content: string;
}

export interface Alert {
  id: string;
  timestamp: number;
  severity: "warning" | "critical";
  type: "bash_rate" | "repetitive" | "stuck_loop" | "similar_loop" | "long_running_bash";
  message: string;
}

export interface StruggleSignals {
  /** Number of error messages detected in recent bash output */
  recentErrorCount: number;
  /** Number of times the same file has been read/edited repeatedly */
  fileRevisitCount: number;
  /** Files that have been visited 3+ times */
  hotFiles: string[];
  /** Number of edit→test→fail cycles detected */
  editFailCycles: number;
  /** Whether Claude's own messages (not tool output) are repeating */
  claudeMessageRepetition: number;
  /** Recent error snippets (deduplicated) */
  recentErrors: string[];
  /** Number of bash commands in last 2 min with no file edits */
  bashWithoutEditStreak: number;
}

export interface MonitorConfig {
  /** Error count threshold for "critical" severity */
  errorThreshold: number;
  /** Edit-fail cycle threshold for "critical" severity */
  editFailThreshold: number;
  /** File revisit count threshold for "warning" severity */
  fileRevisitThreshold: number;
  /** Bash-without-edits streak threshold for "warning" severity */
  bashStreakThreshold: number;
}

export interface HealthSnapshot {
  /** Ratio of file operations to bash commands (higher = healthier) */
  fileVsBashRatio: number;
  /** Total tool calls tracked */
  totalEvents: number;
  /** Current alerts */
  alerts: Alert[];
  /** Recent tool event breakdown */
  breakdown: Record<string, number>;
  /** Repetition score (0=no repetition, 1=fully repetitive) */
  repetitionScore: number;
  /** Whether auto-intervention is enabled */
  autoIntervene: boolean;
  /** Currently running bash command info, if any */
  activeBash: ActiveBashInfo | null;
  /** Whether the monitor considers Claude to be stuck */
  stuckDetected: boolean;
  /** Detailed struggle signals for the monitor UI */
  struggleSignals: StruggleSignals;
  /** Configurable thresholds */
  config: MonitorConfig;
}

export interface ActiveBashInfo {
  /** The command content */
  command: string;
  /** When it started */
  startedAt: number;
  /** Duration in seconds so far */
  durationSec: number;
  /** Whether Claude indicated this would be long-running */
  expectedLong: boolean;
}

const MAX_EVENTS = 2000;
const MAX_RECENT_MESSAGES = 50;

/** How many seconds before a bash command is considered "long-running" */
const LONG_BASH_THRESHOLD_SEC = 120;

/** Similarity threshold for "similar but not identical" command detection */
const SIMILAR_COMMAND_THRESHOLD = 0.6;

/** Patterns that indicate an error in bash output */
const ERROR_PATTERNS = [
  /^error[\s:[\]]/i,
  /^(?:command )?not found/i,
  /^fatal:/i,
  /^(?:ENOENT|EACCES|EPERM|EISDIR|EEXIST)/,
  /^(?:Traceback|SyntaxError|TypeError|ReferenceError|NameError|ImportError|ModuleNotFoundError|ValueError|KeyError|AttributeError|IndentationError)/,
  /^panic:/,
  /^(?:FAIL|FAILED)\b/,
  /compilation failed/i,
  /cannot find module/i,
  /no such file or directory/i,
  /permission denied/i,
  /segmentation fault/i,
  /exit (?:code|status) [1-9]\d*/i,
  /npm ERR!/,
  /(?:Error|Exception):\s+.{10,}/,
];

/** Patterns that indicate Claude expects a long-running operation */
const LONG_TASK_PATTERNS = [
  /this (?:may|might|could|will) take (?:a while|some time|a few minutes|a long time|a moment)/i,
  /long[- ]running/i,
  /takes? (?:a while|some time|a few minutes|several minutes)/i,
  /(?:please )?(?:be )?patient/i,
  /running.+(?:may|might|could|will) take/i,
  /expect(?:ed|ing)? (?:to take|this to|it to)/i,
  /this (?:is|will be) a (?:lengthy|slow)/i,
  /background.*(?:takes?|running)/i,
  /install(?:ing|ation).*(?:dependencies|packages|modules)/i,
  /build(?:ing)?\s+(?:the\s+)?(?:project|app|application)/i,
  /compil(?:ing|ation)/i,
  /running (?:all )?tests/i,
];

const DEFAULT_CONFIG: MonitorConfig = {
  errorThreshold: 5,
  editFailThreshold: 3,
  fileRevisitThreshold: 5,
  bashStreakThreshold: 8,
};

export class ActivityMonitor {
  private events: ToolEvent[] = [];
  private alerts: Alert[] = [];
  private recentMessages: string[] = [];
  private alertIdCounter = 0;
  private listeners: Set<(snapshot: HealthSnapshot) => void> = new Set();

  /** Whether auto-intervention (send ESC + prompt) is enabled */
  autoIntervene = false;

  /** Configurable thresholds */
  config: MonitorConfig = { ...DEFAULT_CONFIG };

  /** Callback to send intervention to the terminal */
  onIntervene: ((message: string) => void) | null = null;

  /** Currently running bash command tracking */
  private activeBashCommand: { command: string; startedAt: number; expectedLong: boolean } | null = null;

  /** Buffer of recent lines (pre-command) to check for long-task indications */
  private recentPreCommandLines: string[] = [];

  /** Timer for checking long-running bash commands */
  private bashCheckInterval: ReturnType<typeof setInterval> | null = null;

  /** Track file paths that have been read/edited, with counts */
  private fileAccessCounts = new Map<string, number>();

  /** Recent error messages from bash output */
  private recentErrors: string[] = [];

  /** Track Claude's own messages (text output between tool calls) */
  private claudeMessages: string[] = [];

  /** Whether we're currently capturing bash output (vs Claude's text) */
  private inBashOutput = false;

  /** Track recent edit→bash sequences to detect edit-fail cycles */
  private recentEditBashResults: Array<{ type: "edit"; file: string } | { type: "bash_error" } | { type: "bash_ok" }> = [];

  constructor() {
    // Periodically check for long-running bash commands
    this.bashCheckInterval = setInterval(() => this.checkLongRunningBash(), 10_000);
  }

  destroy() {
    if (this.bashCheckInterval) {
      clearInterval(this.bashCheckInterval);
      this.bashCheckInterval = null;
    }
  }

  /** Subscribe to health updates. */
  onUpdate(fn: (snapshot: HealthSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Ingest raw PTY output and extract tool events. */
  ingest(data: string) {
    // Claude Code outputs tool usage in recognizable patterns.
    // We look for common markers in the terminal output.
    const lines = data.split("\n");
    for (const line of lines) {
      const stripped = stripAnsi(line).trim();
      if (!stripped) continue;

      let type: ToolEvent["type"] | null = null;

      // Detect tool usage patterns from Claude Code output
      if (/^\$ /.test(stripped) || /^❯ /.test(stripped) || /^Running:/.test(stripped)) {
        type = "bash";
      } else if (/^Read\b/.test(stripped) || /^Reading\b/.test(stripped)) {
        type = "read";
      } else if (/^Writ(e|ing)\b/.test(stripped)) {
        type = "write";
      } else if (/^Edit(ing)?\b/.test(stripped)) {
        type = "edit";
      } else if (/^Glob\b/.test(stripped) || /^Search(ing)?\b/.test(stripped)) {
        type = "glob";
      } else if (/^Grep\b/.test(stripped)) {
        type = "grep";
      }

      if (type) {
        // A new tool event means any previous bash command has completed
        if (this.activeBashCommand && type !== "bash") {
          this.activeBashCommand = null;
          this.inBashOutput = false;
        }

        if (type === "bash") {
          // Check if Claude indicated this would be long-running
          const expectedLong = this.checkExpectedLongTask();
          this.activeBashCommand = {
            command: stripped,
            startedAt: Date.now(),
            expectedLong,
          };
          this.inBashOutput = true;
        }

        // Track file accesses for revisit detection
        if (type === "read" || type === "edit" || type === "write") {
          const filePath = this.extractFilePath(stripped);
          if (filePath) {
            this.fileAccessCounts.set(filePath, (this.fileAccessCounts.get(filePath) || 0) + 1);
          }
        }

        // Track edit→bash sequences for edit-fail cycle detection
        if (type === "edit" || type === "write") {
          const filePath = this.extractFilePath(stripped) || "unknown";
          this.recentEditBashResults.push({ type: "edit", file: filePath });
          if (this.recentEditBashResults.length > 30) this.recentEditBashResults.shift();
        }

        this.addEvent({ timestamp: Date.now(), type, content: stripped });
      } else {
        // Non-tool line — check if it's a prompt (indicating bash finished)
        if (this.activeBashCommand && /^(claude|❯|\$|>)\s*$/.test(stripped)) {
          this.activeBashCommand = null;
          this.inBashOutput = false;
        }

        // Check for errors in bash output
        if (this.inBashOutput && stripped.length > 5) {
          for (const pattern of ERROR_PATTERNS) {
            if (pattern.test(stripped)) {
              const errorSnippet = stripped.slice(0, 120);
              this.recentErrors.push(errorSnippet);
              if (this.recentErrors.length > 50) this.recentErrors.shift();
              // Track as bash error for edit-fail cycle detection
              this.recentEditBashResults.push({ type: "bash_error" });
              if (this.recentEditBashResults.length > 30) this.recentEditBashResults.shift();
              break;
            }
          }
        }

        // Track Claude's own text messages (not tool output)
        // Claude's text appears between tool calls, not during bash output
        if (!this.inBashOutput && stripped.length > 15) {
          // Filter out common non-Claude lines (tool result markers, file contents, etc.)
          if (!this.looksLikeToolOutput(stripped)) {
            this.claudeMessages.push(stripped);
            if (this.claudeMessages.length > 30) this.claudeMessages.shift();
          }
        }
      }

      // Track recent pre-command lines for long-task detection
      if (stripped.length > 5) {
        this.recentPreCommandLines.push(stripped);
        if (this.recentPreCommandLines.length > 30) {
          this.recentPreCommandLines.shift();
        }
      }

      // Track all non-empty lines for repetition detection
      if (stripped.length > 10) {
        this.recentMessages.push(stripped);
        if (this.recentMessages.length > MAX_RECENT_MESSAGES) {
          this.recentMessages.shift();
        }
      }
    }
  }

  /** Extract a file path from a tool usage line like "Read /foo/bar.ts" */
  private extractFilePath(line: string): string | null {
    // Match patterns like "Read /path/to/file", "Edit /path/to/file", "Writing /path/to/file"
    const match = line.match(/(?:Read(?:ing)?|Writ(?:e|ing)|Edit(?:ing)?)\s+(\/\S+)/);
    return match ? match[1] : null;
  }

  /** Heuristic: does this line look like tool output rather than Claude's own text? */
  private looksLikeToolOutput(line: string): boolean {
    // Lines that are likely file contents or command output, not Claude speaking
    return (
      /^\s*\d+[:\s│|]/.test(line) ||      // Line-numbered output (file contents)
      /^[│|├└─┌┐┘┤┴┬]/.test(line) ||      // Box drawing / tree output
      /^\s*[{}[\]<>]/.test(line) ||         // JSON/XML/code structure
      /^\s*(import|export|const|let|var|function|class|def|if|for|while|return)\b/.test(line) || // Code
      /^\s*\/\//.test(line) ||              // Code comments
      /^\s*#/.test(line) ||                 // Code comments / shell
      /^\s*\*/.test(line) ||                // Bullet or block comment
      /^\d+\s+(passing|failing|pending)/.test(line) || // Test output
      /^\s*at\s+/.test(line)               // Stack trace
    );
  }

  private addEvent(event: ToolEvent) {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS / 2);
    }

    this.checkAlerts();
    this.notifyListeners();
  }

  private checkAlerts() {
    let isStuck = false;

    // 1. Check for exact repetitive commands (same command repeated 3+ times in last 10)
    const last10 = this.events.slice(-10);
    const commandCounts = new Map<string, number>();
    for (const e of last10) {
      const key = `${e.type}:${e.content}`;
      commandCounts.set(key, (commandCounts.get(key) || 0) + 1);
    }
    for (const [key, count] of commandCounts) {
      if (count >= 3) {
        this.addAlert("critical", "stuck_loop", `Possible stuck loop: "${key.slice(0, 80)}" repeated ${count}x in last 10 events`);
        isStuck = true;
        break;
      }
    }

    // 2. Check for similar (but not identical) repeated commands
    if (!isStuck) {
      isStuck = this.checkSimilarCommands(last10);
    }

    // 3. Check message repetition score
    const repScore = this.computeRepetitionScore();
    if (repScore > 0.6) {
      this.addAlert("warning", "repetitive", `High output repetition detected (score: ${repScore.toFixed(2)})`);
      if (repScore > 0.75) isStuck = true;
    }

    // Trigger intervention if stuck and auto-intervene is on
    if (isStuck && this.autoIntervene && this.onIntervene) {
      // Only intervene if we haven't recently (60s cooldown)
      const recentIntervention = this.alerts.find(
        (a) => a.type === "stuck_loop" && a.message.includes("[auto-intervened]") && Date.now() - a.timestamp < 60_000,
      );
      if (!recentIntervention) {
        this.onIntervene("It looks like you're stuck in a loop. Try a different approach.");
        this.addAlert("critical", "stuck_loop", "[auto-intervened] Sent escape and redirect prompt to Claude");
      }
    }
  }

  /** Check if recent commands are similar (not identical) — indicates a stuck pattern with slight variations. */
  private checkSimilarCommands(recentEvents: ToolEvent[]): boolean {
    // Only look at bash commands for similar-command detection
    const bashEvents = recentEvents.filter((e) => e.type === "bash");
    if (bashEvents.length < 3) return false;

    // Check if 3+ of the last 5 bash commands are similar to each other
    const lastBash = bashEvents.slice(-5);
    for (let i = 0; i < lastBash.length; i++) {
      let similarCount = 1;
      for (let j = i + 1; j < lastBash.length; j++) {
        // Skip exact matches (already caught by stuck_loop)
        if (lastBash[i].content === lastBash[j].content) continue;
        const sim = trigramSimilarity(lastBash[i].content, lastBash[j].content);
        if (sim >= SIMILAR_COMMAND_THRESHOLD) {
          similarCount++;
        }
      }
      if (similarCount >= 3) {
        this.addAlert(
          "warning",
          "similar_loop",
          `Similar bash commands repeating (${similarCount}x similar in last ${lastBash.length} bash calls) — may indicate a stuck pattern with slight variations`,
        );
        return true;
      }
    }
    return false;
  }

  /** Check if Claude recently indicated the next task would be long-running. */
  private checkExpectedLongTask(): boolean {
    // Look at the last 15 lines before the bash command
    const recent = this.recentPreCommandLines.slice(-15);
    for (const line of recent) {
      for (const pattern of LONG_TASK_PATTERNS) {
        if (pattern.test(line)) {
          return true;
        }
      }
    }
    return false;
  }

  /** Periodically check if the active bash command has been running too long. */
  private checkLongRunningBash() {
    if (!this.activeBashCommand) return;

    const elapsed = (Date.now() - this.activeBashCommand.startedAt) / 1000;

    // If Claude said it would be long, use a much higher threshold (10 min)
    const threshold = this.activeBashCommand.expectedLong
      ? LONG_BASH_THRESHOLD_SEC * 5
      : LONG_BASH_THRESHOLD_SEC;

    if (elapsed > threshold) {
      const cmdPreview = this.activeBashCommand.command.slice(0, 80);
      const qualifier = this.activeBashCommand.expectedLong
        ? " (even though Claude indicated it might take a while)"
        : "";
      this.addAlert(
        "warning",
        "long_running_bash",
        `Bash command running for ${Math.floor(elapsed)}s${qualifier}: "${cmdPreview}"`,
      );
      this.notifyListeners();
    }
  }

  private addAlert(severity: Alert["severity"], type: Alert["type"], message: string) {
    // Deduplicate: don't re-alert same type within 30 seconds
    const recent = this.alerts.find(
      (a) => a.type === type && Date.now() - a.timestamp < 30_000,
    );
    if (recent) return;

    this.alerts.push({
      id: String(++this.alertIdCounter),
      timestamp: Date.now(),
      severity,
      type,
      message,
    });

    // Keep last 50 alerts
    if (this.alerts.length > 50) {
      this.alerts = this.alerts.slice(-50);
    }
  }

  /** Compute similarity between recent messages using trigram overlap. */
  private computeRepetitionScore(): number {
    const msgs = this.recentMessages.slice(-20);
    if (msgs.length < 5) return 0;

    let totalSimilarity = 0;
    let comparisons = 0;

    for (let i = 0; i < msgs.length; i++) {
      for (let j = i + 1; j < msgs.length; j++) {
        totalSimilarity += trigramSimilarity(msgs[i], msgs[j]);
        comparisons++;
      }
    }

    return comparisons > 0 ? totalSimilarity / comparisons : 0;
  }

  /** Compute struggle signals from tracked data. */
  private computeStruggleSignals(): StruggleSignals {
    // 1. Recent error count (last 2 minutes based on recency of errors list)
    const recentErrorCount = this.recentErrors.length;

    // 2. File revisits — files accessed 3+ times
    let fileRevisitCount = 0;
    const hotFiles: string[] = [];
    for (const [file, count] of this.fileAccessCounts) {
      if (count >= 3) {
        fileRevisitCount += count - 2; // excess visits beyond 2
        hotFiles.push(`${file} (${count}x)`);
      }
    }

    // 3. Edit-fail cycles: count sequences of edit → bash_error
    let editFailCycles = 0;
    let lastEdit = false;
    for (const entry of this.recentEditBashResults) {
      if (entry.type === "edit") {
        lastEdit = true;
      } else if (entry.type === "bash_error" && lastEdit) {
        editFailCycles++;
        lastEdit = false;
      } else if (entry.type === "bash_ok") {
        lastEdit = false;
      }
    }

    // 4. Claude message repetition (filtered to actual Claude text, not tool output)
    const claudeMsgs = this.claudeMessages.slice(-15);
    let claudeMessageRepetition = 0;
    if (claudeMsgs.length >= 4) {
      let totalSim = 0;
      let comparisons = 0;
      for (let i = 0; i < claudeMsgs.length; i++) {
        for (let j = i + 1; j < claudeMsgs.length; j++) {
          totalSim += trigramSimilarity(claudeMsgs[i], claudeMsgs[j]);
          comparisons++;
        }
      }
      claudeMessageRepetition = comparisons > 0 ? totalSim / comparisons : 0;
    }

    // 5. Deduplicated recent errors (show unique ones)
    const uniqueErrors = [...new Set(this.recentErrors.slice(-20))].slice(-5);

    // 6. Bash without edit streak — count recent bash events with no interleaved edits
    const twoMinAgo = Date.now() - 120_000;
    const recentEvents = this.events.filter((e) => e.timestamp > twoMinAgo);
    let bashWithoutEditStreak = 0;
    let currentStreak = 0;
    for (const e of recentEvents) {
      if (e.type === "bash") {
        currentStreak++;
        bashWithoutEditStreak = Math.max(bashWithoutEditStreak, currentStreak);
      } else if (e.type === "edit" || e.type === "write") {
        currentStreak = 0;
      }
    }

    return {
      recentErrorCount,
      fileRevisitCount,
      hotFiles: hotFiles.slice(0, 5),
      editFailCycles,
      claudeMessageRepetition,
      recentErrors: uniqueErrors,
      bashWithoutEditStreak,
    };
  }

  getHealth(): HealthSnapshot {
    const now = Date.now();
    const oneMinAgo = now - 60_000;
    const recentEvents = this.events.filter((e) => e.timestamp > oneMinAgo);

    const breakdown: Record<string, number> = {};
    let fileOps = 0;
    let bashOps = 0;

    for (const e of recentEvents) {
      breakdown[e.type] = (breakdown[e.type] || 0) + 1;
      if (e.type === "read" || e.type === "write" || e.type === "edit") fileOps++;
      if (e.type === "bash") bashOps++;
    }

    const activeAlerts = this.alerts.filter((a) => now - a.timestamp < 300_000);
    const struggleSignals = this.computeStruggleSignals();

    const stuckDetected = activeAlerts.some(
      (a) => a.type === "stuck_loop" || a.type === "similar_loop" || (a.type === "repetitive" && this.computeRepetitionScore() > 0.75),
    ) || struggleSignals.editFailCycles >= this.config.editFailThreshold || (struggleSignals.recentErrorCount >= this.config.errorThreshold && struggleSignals.claudeMessageRepetition > 0.5);

    let activeBash: ActiveBashInfo | null = null;
    if (this.activeBashCommand) {
      const durationSec = Math.floor((now - this.activeBashCommand.startedAt) / 1000);
      activeBash = {
        command: this.activeBashCommand.command,
        startedAt: this.activeBashCommand.startedAt,
        durationSec,
        expectedLong: this.activeBashCommand.expectedLong,
      };
    }

    return {
      fileVsBashRatio: bashOps > 0 ? fileOps / bashOps : fileOps > 0 ? Infinity : 0,
      totalEvents: this.events.length,
      alerts: activeAlerts,
      breakdown,
      repetitionScore: this.computeRepetitionScore(),
      autoIntervene: this.autoIntervene,
      activeBash,
      stuckDetected,
      struggleSignals,
      config: { ...this.config },
    };
  }

  clearAlerts() {
    this.alerts = [];
    this.notifyListeners();
  }

  private notifyListeners() {
    const snapshot = this.getHealth();
    for (const fn of this.listeners) {
      try { fn(snapshot); } catch {}
    }
  }
}

// --- Utilities ---

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");
}

/** Trigram similarity between two strings (Jaccard index of trigram sets). */
function trigramSimilarity(a: string, b: string): number {
  const triA = trigrams(a);
  const triB = trigrams(b);
  if (triA.size === 0 && triB.size === 0) return 1;
  if (triA.size === 0 || triB.size === 0) return 0;

  let intersection = 0;
  for (const t of triA) {
    if (triB.has(t)) intersection++;
  }

  return intersection / (triA.size + triB.size - intersection);
}

function trigrams(s: string): Set<string> {
  const set = new Set<string>();
  const lower = s.toLowerCase();
  for (let i = 0; i <= lower.length - 3; i++) {
    set.add(lower.slice(i, i + 3));
  }
  return set;
}
