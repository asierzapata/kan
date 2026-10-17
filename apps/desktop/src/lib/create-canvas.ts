/**
 * Creating a canvas. Every canvas lives on this device: the catalog entry is
 * what the thread store and the tldraw persistence key are keyed on.
 */
import { createOfflineCanvas } from "./canvas-repository";

export interface CreatedCanvas {
  localCanvasId: string;
}

export async function createCanvas(name: string): Promise<CreatedCanvas> {
  const entry = await createOfflineCanvas({ name });
  return { localCanvasId: entry.id };
}
