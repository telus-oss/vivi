import { describe, it, expect, beforeEach } from "vitest";
import { getPanelWidth, savePanelWidth, clampWidth } from "../lib/panelResize";

describe("Panel Resize", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns default 50% when no width saved", () => {
    expect(getPanelWidth()).toBe(50);
  });

  it("saves and retrieves a width", () => {
    savePanelWidth(65);
    expect(getPanelWidth()).toBe(65);
  });

  it("clamps width to minimum 20%", () => {
    expect(clampWidth(10)).toBe(20);
    expect(clampWidth(0)).toBe(20);
    expect(clampWidth(-5)).toBe(20);
  });

  it("clamps width to maximum 80%", () => {
    expect(clampWidth(90)).toBe(80);
    expect(clampWidth(100)).toBe(80);
    expect(clampWidth(150)).toBe(80);
  });

  it("allows values within range", () => {
    expect(clampWidth(20)).toBe(20);
    expect(clampWidth(50)).toBe(50);
    expect(clampWidth(80)).toBe(80);
    expect(clampWidth(35.5)).toBe(35.5);
  });

  it("persists clamped value to localStorage", () => {
    savePanelWidth(95);
    expect(getPanelWidth()).toBe(80);

    savePanelWidth(5);
    expect(getPanelWidth()).toBe(20);
  });

  it("handles corrupted localStorage gracefully", () => {
    localStorage.setItem("panel-width", "not-a-number");
    expect(getPanelWidth()).toBe(50);
  });

  it("handles missing localStorage gracefully", () => {
    localStorage.removeItem("panel-width");
    expect(getPanelWidth()).toBe(50);
  });

  it("preserves decimal precision", () => {
    savePanelWidth(42.7);
    expect(getPanelWidth()).toBeCloseTo(42.7);
  });
});
