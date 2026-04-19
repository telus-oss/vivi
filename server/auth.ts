/**
 * Claude token capture.
 *
 * The PTY server runs `claude setup-token` and feeds output here.
 * We accumulate all output and extract the token when consumed.
 *
 * The output contains: ...some text... sk-ant-oat01-<chars>\nStore...
 * We grab from "sk-ant-" to "Store " and strip all whitespace.
 */

let outputBuffer = "";

export function ingestSetupTokenOutput(data: string) {
  outputBuffer += data;
}

export function consumeCapturedToken(): string | null {
  // Strip ANSI escape codes
  const stripped = outputBuffer
    .replace(/\x1B\[[?]?[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1B\][^\x07]*\x07/g, "")
    .replace(/\x1B[()][A-Z0-9]/g, "");

  outputBuffer = "";

  const startIdx = stripped.indexOf("sk-ant-");
  if (startIdx < 0) {
    console.log("[auth] No token found in output");
    return null;
  }

  const endIdx = stripped.indexOf("Store ", startIdx);
  const raw = endIdx > startIdx
    ? stripped.slice(startIdx, endIdx)
    : stripped.slice(startIdx);

  const token = raw.replace(/[\s\r\n]+/g, "");

  if (token.length > 20) {
    console.log("[auth] Captured token (length:", token.length, ")");
    return token;
  }

  console.log("[auth] Token too short:", token.length);
  return null;
}

export function resetCapture() {
  outputBuffer = "";
}
