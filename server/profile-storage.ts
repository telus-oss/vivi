/**
 * Profile storage — optional S3-compatible (MinIO) backing store for
 * named-profile snapshots.
 *
 * The base profile flow (server/profiles.ts) keeps profile state on the
 * Vivi-server's local disk. This module layers a remote sync on top:
 *   - On profile save: upload a .tar.gz to S3 under <bucket>/<profileId>.tar.gz
 *   - On profile load (if local copy missing): download from S3 first
 *
 * Configuration (env-driven, all required to enable):
 *   VIVI_S3_ENDPOINT   e.g. "vivi-minio:9000" — host[:port], plain TCP
 *   VIVI_S3_ACCESS_KEY
 *   VIVI_S3_SECRET_KEY
 *   VIVI_S3_BUCKET     defaults to "profiles"
 *   VIVI_S3_USE_SSL    "1" to enable HTTPS; default plain HTTP (MinIO in-cluster)
 *   VIVI_S3_REGION     defaults to "us-east-1" (MinIO ignores it)
 *
 * Tied to the optional MinIO Deployment in the Helm chart
 * (deploy/helm/vivi/templates/minio.yaml). External S3 buckets work too.
 */

import { Client } from "minio";
import fs from "node:fs";

const bucket = process.env.VIVI_S3_BUCKET || "profiles";

function buildClient(): Client | null {
  const endpoint = process.env.VIVI_S3_ENDPOINT;
  const accessKey = process.env.VIVI_S3_ACCESS_KEY;
  const secretKey = process.env.VIVI_S3_SECRET_KEY;
  if (!endpoint || !accessKey || !secretKey) return null;

  // Endpoint can be "host" or "host:port"
  const colon = endpoint.lastIndexOf(":");
  const host = colon === -1 ? endpoint : endpoint.slice(0, colon);
  const port = colon === -1 ? undefined : Number(endpoint.slice(colon + 1));
  const useSSL = process.env.VIVI_S3_USE_SSL === "1";

  try {
    return new Client({
      endPoint: host,
      port,
      useSSL,
      accessKey,
      secretKey,
      region: process.env.VIVI_S3_REGION || "us-east-1",
    });
  } catch (err: any) {
    console.warn(`[profile-storage] Failed to init MinIO client: ${err.message}`);
    return null;
  }
}

let _client: Client | null | undefined;
function client(): Client | null {
  if (_client === undefined) {
    _client = buildClient();
    if (_client) {
      console.log(`[profile-storage] S3 enabled: ${process.env.VIVI_S3_ENDPOINT} bucket=${bucket}`);
    }
  }
  return _client;
}

/** True when env vars are set; profile storage will fall back to local-only when false. */
export function isEnabled(): boolean {
  return client() !== null;
}

/** Idempotently ensure the bucket exists. */
async function ensureBucket(c: Client): Promise<void> {
  const exists = await c.bucketExists(bucket).catch(() => false);
  if (!exists) {
    await c.makeBucket(bucket, process.env.VIVI_S3_REGION || "us-east-1");
    console.log(`[profile-storage] Created bucket ${bucket}`);
  }
}

function objectKey(profileId: string): string {
  // Trust profileId is already validated upstream (UUID / safe chars); the
  // existing profiles.ts uses crypto.randomUUID, no traversal risk.
  return `${profileId}.tar.gz`;
}

/**
 * Upload a profile snapshot (tar.gz already produced by profiles.ts) to S3.
 * Best-effort — failures are logged, not thrown, so the host-side save still
 * "succeeds" and the user is not blocked.
 */
export async function uploadProfile(profileId: string, tarGzPath: string): Promise<boolean> {
  const c = client();
  if (!c) return false;
  try {
    await ensureBucket(c);
    const stat = fs.statSync(tarGzPath);
    await c.fPutObject(bucket, objectKey(profileId), tarGzPath, {
      "Content-Type": "application/gzip",
    });
    console.log(`[profile-storage] Uploaded profile ${profileId} → s3://${bucket}/${objectKey(profileId)} (${stat.size} bytes)`);
    return true;
  } catch (err: any) {
    console.warn(`[profile-storage] Upload failed for ${profileId}: ${err.message}`);
    return false;
  }
}

/**
 * Download a profile snapshot from S3 to a local path. Returns true on success,
 * false if the object is missing or storage is unconfigured.
 */
export async function downloadProfile(profileId: string, destPath: string): Promise<boolean> {
  const c = client();
  if (!c) return false;
  try {
    await c.fGetObject(bucket, objectKey(profileId), destPath);
    console.log(`[profile-storage] Downloaded profile ${profileId} ← s3://${bucket}/${objectKey(profileId)}`);
    return true;
  } catch (err: any) {
    if (err.code === "NoSuchKey" || err.code === "NotFound") return false;
    console.warn(`[profile-storage] Download failed for ${profileId}: ${err.message}`);
    return false;
  }
}

export async function deleteProfile(profileId: string): Promise<void> {
  const c = client();
  if (!c) return;
  try {
    await c.removeObject(bucket, objectKey(profileId));
  } catch (err: any) {
    console.warn(`[profile-storage] Delete failed for ${profileId}: ${err.message}`);
  }
}
