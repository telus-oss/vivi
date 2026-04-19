import { useState, useEffect, useCallback } from "react";
import { Box, Plus, Trash2, Star } from "lucide-react";
import type { SandboxImage } from "../lib/types";
import * as api from "../lib/api";

export function SandboxImages() {
  const [images, setImages] = useState<SandboxImage[] | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [imageInput, setImageInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setImages(await api.listSandboxImages());
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (!images) return null;

  const addImage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameInput.trim() || !imageInput.trim()) return;
    try {
      setError(null);
      await api.addSandboxImage(nameInput.trim(), imageInput.trim());
      setNameInput("");
      setImageInput("");
      refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("Failed to add sandbox image:", msg);
      setError(msg);
    }
  };

  const deleteImage = async (id: number) => {
    try {
      await api.removeSandboxImage(id);
      refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("Failed to remove sandbox image:", id, msg);
      setError(msg);
    }
  };

  const setDefault = async (id: number) => {
    try {
      await api.setSandboxImageDefault(id);
      refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("Failed to set default sandbox image:", id, msg);
      setError(msg);
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Box className="w-5 h-5 text-[var(--color-accent)]" />
          <h2 className="text-lg font-semibold">Sandbox Images</h2>
        </div>
        <p className="text-sm text-gray-400">
          Docker images available for sandbox containers. The default image is used when no specific image is selected.
        </p>

        <form onSubmit={addImage} className="flex gap-2">
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder="Image name"
            className="flex-1 px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded text-sm focus:border-[var(--color-accent)] focus:outline-none"
          />
          <input
            value={imageInput}
            onChange={(e) => setImageInput(e.target.value)}
            placeholder="Docker image reference"
            className="flex-1 px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded text-sm font-mono focus:border-[var(--color-accent)] focus:outline-none"
          />
          <button
            type="submit"
            className="px-3 py-2 bg-[var(--color-accent-muted)] hover:bg-[var(--color-accent)] text-white rounded text-sm transition-colors"
          >
            <Plus className="w-4 h-4" />
          </button>
        </form>

        {error && (
          <p className="text-sm text-red-400">{error}</p>
        )}

        <div className="space-y-1">
          {images.map((img) => (
            <div
              key={img.id}
              className="flex items-center justify-between px-3 py-2 bg-[var(--color-surface-raised)] rounded border border-[var(--color-border)]"
            >
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">{img.name}</span>
                <code className="text-xs text-[var(--color-accent)] font-mono">{img.image}</code>
                {img.isDefault && (
                  <span className="flex items-center gap-1 px-1.5 py-0.5 text-xs rounded bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
                    <Star className="w-3 h-3" />
                    Default
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setDefault(img.id)}
                  disabled={img.isDefault}
                  className="px-2 py-1 text-xs rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-gray-400 hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-muted)]"
                >
                  Set Default
                </button>
                <button
                  onClick={() => deleteImage(img.id)}
                  disabled={img.isDefault || images.length === 1}
                  className="p-1 text-gray-500 hover:text-red-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  aria-label="Delete image"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
