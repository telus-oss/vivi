/**
 * Sandbox image management — backed by SQLite.
 *
 * Tracks Docker images available for sandbox containers.
 * Exactly one image must always be marked as the default.
 */

import { execFileSync } from "node:child_process";
import db from "./db.js";
import { runtime } from "./runtime.js";

export interface SandboxImage {
  id: number;
  name: string;
  image: string;
  isDefault: boolean;
  createdAt: string;
}

function rowToImage(row: any): SandboxImage {
  return {
    id: row.id,
    name: row.name,
    image: row.image,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
  };
}

// --- Prepared statements ---
const stmts = {
  list: db.prepare("SELECT * FROM sandbox_images ORDER BY id"),
  getById: db.prepare("SELECT * FROM sandbox_images WHERE id = ?"),
  getDefault: db.prepare("SELECT * FROM sandbox_images WHERE is_default = 1"),
  countAll: db.prepare("SELECT COUNT(*) as count FROM sandbox_images"),
  insert: db.prepare("INSERT INTO sandbox_images (name, image) VALUES (?, ?)"),
  deleteById: db.prepare("DELETE FROM sandbox_images WHERE id = ?"),
};

// --- Transaction ---
const setDefaultTx = db.transaction((id: number) => {
  db.prepare("UPDATE sandbox_images SET is_default = 0 WHERE is_default = 1").run();
  db.prepare("UPDATE sandbox_images SET is_default = 1 WHERE id = ?").run(id);
});

/** Validate the display name for a sandbox image. */
function validateDisplayName(name: string): void {
  if (!name || name.length === 0) {
    throw new Error("Display name must not be empty.");
  }
  if (name.length > 100) {
    throw new Error(
      `Display name must be at most 100 characters (got ${name.length}).`
    );
  }
  // Allow only printable ASCII (space through tilde) — no control chars
  if (!/^[\x20-\x7E]+$/.test(name)) {
    throw new Error(
      "Display name contains invalid characters. Only printable ASCII characters are allowed."
    );
  }
}

/** Validate the image string to prevent command injection. */
function validateImageName(image: string): void {
  if (!image || image.length === 0) {
    throw new Error("Docker image reference must not be empty.");
  }
  if (image.length > 256) {
    throw new Error(
      `Docker image reference must be at most 256 characters (got ${image.length}).`
    );
  }
  if (!/^[a-zA-Z0-9._\-\/:]+$/.test(image)) {
    throw new Error(
      `Invalid Docker image name '${image}'. Only alphanumeric characters, hyphens, underscores, dots, colons, and forward slashes are allowed.`
    );
  }
}

/** Return all rows from sandbox_images ordered by id. */
export function listImages(): SandboxImage[] {
  const rows = stmts.list.all();
  return rows.map(rowToImage);
}

/** Insert a new image after validating it exists locally via docker image inspect. */
export function addImage(name: string, image: string): SandboxImage {
  validateDisplayName(name);
  validateImageName(image);

  try {
    execFileSync(runtime.bin, ["image", "inspect", image], { stdio: "pipe", timeout: 5_000 });
  } catch (err) {
    throw new Error(`Docker image '${image}' not found locally. Pull or build it first.`);
  }

  const result = stmts.insert.run(name, image);
  const row = stmts.getById.get(result.lastInsertRowid);
  if (!row) {
    throw new Error(`Failed to retrieve inserted sandbox image with id ${result.lastInsertRowid}.`);
  }
  return rowToImage(row);
}

/** Delete a sandbox image by ID. */
export function removeImage(id: number): void {
  const row = stmts.getById.get(id) as any;
  if (!row) {
    throw new Error(`Sandbox image with id ${id} not found.`);
  }

  if (row.is_default === 1) {
    throw new Error(
      `Cannot remove sandbox image '${row.name}' (id ${id}) because it is the default. Set another image as default first.`
    );
  }

  const countRow = stmts.countAll.get() as any;
  if (countRow.count <= 1) {
    throw new Error(`Cannot remove the last remaining sandbox image (id ${id}).`);
  }

  stmts.deleteById.run(id);
}

/** Set the image with the given ID as the default. */
export function setDefault(id: number): SandboxImage {
  const row = stmts.getById.get(id);
  if (!row) {
    throw new Error(`Sandbox image with id ${id} not found.`);
  }

  setDefaultTx(id);

  const updated = stmts.getById.get(id);
  if (!updated) {
    throw new Error(`Failed to retrieve sandbox image with id ${id} after setting as default.`);
  }
  return rowToImage(updated);
}

/** Return a sandbox image by ID, or null if not found. */
export function getById(id: number): SandboxImage | null {
  const row = stmts.getById.get(id);
  return row ? rowToImage(row) : null;
}

/** Return the image currently marked as default. */
export function getDefault(): SandboxImage {
  const row = stmts.getDefault.get();
  if (!row) {
    throw new Error("No default sandbox image is configured.");
  }
  return rowToImage(row);
}
