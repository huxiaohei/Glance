import { Channel, invoke } from "@tauri-apps/api/core";
import type { CatalogEvent, FileId, ImageDetails, RootInfo, ThumbEvent, Tier } from "./types";

function channel<T>(onEvent: (e: T) => void): Channel<T> {
  const ch = new Channel<T>();
  ch.onmessage = onEvent;
  return ch;
}

export function openPath(
  path: string,
  recursive: boolean,
  seq: number,
  onEvent: (e: CatalogEvent) => void,
): Promise<RootInfo> {
  return invoke<RootInfo>("open_path", { path, recursive, seq, onEvent: channel(onEvent) });
}

export function thumbsSubscribe(onEvent: (e: ThumbEvent) => void): Promise<void> {
  return invoke<void>("thumbs_subscribe", { onEvent: channel(onEvent) });
}

export function thumbsWant(consumer: string, ids: FileId[], tier: Tier): Promise<{ id: FileId; v: string }[]> {
  return invoke<{ id: FileId; v: string }[]>("thumbs_want", { consumer, ids, tier });
}

export function imageDetails(id: FileId): Promise<ImageDetails> {
  return invoke<ImageDetails>("image_details", { id });
}
