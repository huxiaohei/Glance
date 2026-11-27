/** 需要系统解码器的格式：按扩展名认。HEIC / HEIF 同属 `heif`。 */
export type CodecKind = "heif" | "avif";

export function codecKindOf(name: string): CodecKind | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  switch (name.slice(dot + 1).toLowerCase()) {
    case "heic":
    case "heif":
      return "heif";
    case "avif":
      return "avif";
    default:
      return null;
  }
}

/** 名字都是 HEIC / HEIF / AVIF 才为真；空列表为假。批量压缩据此置灰（混选时这些图由后端跳过）。 */
export function allCodecNames(names: readonly string[]): boolean {
  return names.length > 0 && names.every((n) => codecKindOf(n) !== null);
}
