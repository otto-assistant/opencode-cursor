import type { ContentPart, ExtractedImage, OpenAIMessage } from "./types.js";

function imageUrlFromPart(part: ContentPart): string | undefined {
  if (typeof part.image_url === "string" && part.image_url.trim()) {
    return part.image_url.trim();
  }
  if (
    part.image_url &&
    typeof part.image_url === "object" &&
    typeof part.image_url.url === "string" &&
    part.image_url.url.trim()
  ) {
    return part.image_url.url.trim();
  }
  if (typeof part.url === "string" && part.url.trim()) {
    return part.url.trim();
  }
  return undefined;
}

function guessMimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function decodeDataUrl(dataUrl: string): ExtractedImage | undefined {
  const match =
    /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/i.exec(
      dataUrl.trim(),
    );
  if (!match) return undefined;
  const mimeType =
    (match[1] || "application/octet-stream").trim() ||
    "application/octet-stream";
  try {
    const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
    if (bytes.byteLength === 0) return undefined;
    const ext = mimeType.includes("png")
      ? "png"
      : mimeType.includes("jpeg") || mimeType.includes("jpg")
        ? "jpg"
        : mimeType.includes("gif")
          ? "gif"
          : mimeType.includes("webp")
            ? "webp"
            : "bin";
    return {
      bytes: new Uint8Array(bytes),
      mimeType,
      filename: `attachment.${ext}`,
    };
  } catch {
    return undefined;
  }
}

function decodeBase64Payload(data: string): Uint8Array | undefined {
  try {
    const bytes = new Uint8Array(
      Buffer.from(
        data.replace(/^data:[^,]*,/, "").replace(/\s+/g, ""),
        "base64",
      ),
    );
    return bytes.byteLength > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract image attachments from an OpenAI / OpenCode content payload.
 * Supports `image_url` parts (data URLs) and file-like parts with base64 `data`.
 */
export function extractImagesFromContent(
  content: OpenAIMessage["content"],
): ExtractedImage[] {
  if (content == null || typeof content === "string") return [];
  const images: ExtractedImage[] = [];
  for (const part of content) {
    const type = (part.type || "").toLowerCase();
    const filename =
      (typeof part.filename === "string" && part.filename) ||
      (typeof part.name === "string" && part.name) ||
      "attachment";

    if (type === "image_url" || type === "image" || type === "input_image") {
      const url = imageUrlFromPart(part);
      if (url?.startsWith("data:")) {
        const decoded = decodeDataUrl(url);
        if (decoded) {
          images.push({
            ...decoded,
            filename: filename.includes(".") ? filename : decoded.filename,
          });
        }
      } else if (typeof part.data === "string" && part.data.trim()) {
        const bytes = decodeBase64Payload(part.data);
        if (bytes) {
          const mimeType =
            part.mime_type ||
            part.mime ||
            guessMimeFromName(filename) ||
            "image/png";
          images.push({ bytes, mimeType, filename });
        }
      }
      continue;
    }

    // OpenCode sometimes emits generic file parts for image attachments.
    if (type === "file" || type === "input_file") {
      const mime = (part.mime_type || part.mime || "").toLowerCase();
      const looksImage =
        mime.startsWith("image/") ||
        /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filename);
      if (!looksImage) continue;
      if (typeof part.data === "string" && part.data.trim()) {
        const bytes = decodeBase64Payload(part.data);
        if (bytes) {
          images.push({
            bytes,
            mimeType: mime || guessMimeFromName(filename) || "image/png",
            filename,
          });
        }
        continue;
      }
      const url = imageUrlFromPart(part);
      if (url?.startsWith("data:")) {
        const decoded = decodeDataUrl(url);
        if (decoded) {
          images.push({
            ...decoded,
            filename: filename.includes(".") ? filename : decoded.filename,
            mimeType: mime || decoded.mimeType,
          });
        }
      }
    }
  }
  return images;
}
