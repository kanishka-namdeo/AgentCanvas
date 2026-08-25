// attachments.ts — image attachments for the agent chat.
//
// UX pattern (researched from how established apps do it):
//
//   - ChatGPT / Claude / Cursor all offer the same trio: a paperclip button,
//     clipboard paste (Ctrl/Cmd+V), and drag-and-drop onto the chat area.
//     Thumbnails with a remove "×" preview before sending.
//   - LM Studio only reveals the image-attach affordance when the selected
//     model is vision-capable; Cursor surfaces "model does not support
//     images" errors when an image rides along on a text-only model.
//     We mirror the *guard*: the attach button stays available (users can
//     stage images before switching models) but a warning chip appears when
//     the currently resolved model lacks image input.
//
// Size strategy: browser images (screenshots, photos) are routinely 2-8MB,
// which base64-inflates ~33% and would bloat both the WebSocket frame and
// the localStorage-persisted session history. Attachments are downscaled to
// at most 1280px on the longest edge and re-encoded as JPEG (or PNG when
// transparency matters) before they ever leave this module — reference
// screenshots at 1280px remain perfectly legible for a vision LLM.

/// A staged/attached image as carried through stores, events, and persistence.
export interface AttachedImage {
  id: string;
  /// Original file name (kept for display only).
  name: string;
  /// `data:image/jpeg;base64,…` — downscaled, ready for transport.
  dataUrl: string;
}

/// Hard limits — enforced at selection time so nothing larger ever
/// reaches the wire or localStorage.
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
/// Downscale ceiling (longest edge, px).
export const DOWNSCALE_MAX_EDGE = 1280;
/// Hard cap on the FINAL dataUrl length (~1.5MB base64 ≈ 1.1MB binary).
export const MAX_DATAURL_LENGTH = 1_600_000;

function newId(): string {
  return `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

/// Extract image files from a clipboard or drag event.
/// Works for both DataTransfer (drop) and ClipboardEvent (paste).
export function imageFilesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const files: File[] = [];
  // Prefer items (includes OS drag payloads); fall back to .files.
  if (dt.items && typeof dt.items.length === 'number') {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f && isImageFile(f)) files.push(f);
      }
    }
  }
  if (files.length === 0 && dt.files) {
    for (let i = 0; i < dt.files.length; i++) {
      const f = dt.files[i];
      if (isImageFile(f)) files.push(f);
    }
  }
  return files;
}

/// Downscale + re-encode an image file. Returns the compact data URL.
/// PNGs with transparency stay PNG; everything else becomes JPEG q0.85.
/// Rejects the promise for unreadable/corrupt images (callers toast).
export function downscaleImageFile(
  file: File,
  maxEdge = DOWNSCALE_MAX_EDGE,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error(`${file.name} is not a readable image`));
      img.onload = () => {
        try {
          const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            // Canvas unavailable — fall back to the original bytes.
            resolve(String(reader.result));
            return;
          }
          // PNG preserves transparency; JPEG is smaller for photos/screens.
          const keepPng = file.type === 'image/png' || file.type === 'image/gif';
          if (!keepPng) {
            // White-matte JPEGs (avoids black backgrounds on transparent sources).
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
          }
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = keepPng
            ? canvas.toDataURL('image/png')
            : canvas.toDataURL('image/jpeg', 0.85);
          resolve(dataUrl);
        } catch (err) {
          reject(err instanceof Error ? err : new Error('Canvas encoding failed'));
        }
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export interface StageResult {
  /// Successfully staged attachments (append to the pending list).
  staged: AttachedImage[];
  /// Human-readable rejection reasons (one per refused file).
  rejections: string[];
}

/// Validate + stage a batch of image files against the current pending list.
/// Pure-ish: returns the new attachments; the caller owns the pending array.
export async function stageImageFiles(
  files: File[],
  alreadyPending: number,
): Promise<StageResult> {
  const staged: AttachedImage[] = [];
  const rejections: string[] = [];
  for (const file of files) {
    if (alreadyPending + staged.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      rejections.push(`${file.name}: limit is ${MAX_ATTACHMENTS_PER_MESSAGE} images per message`);
      continue;
    }
    if (!isImageFile(file)) {
      rejections.push(`${file.name}: not an image`);
      continue;
    }
    try {
      const dataUrl = await downscaleImageFile(file);
      if (dataUrl.length > MAX_DATAURL_LENGTH) {
        rejections.push(`${file.name}: too large even after downscaling`);
        continue;
      }
      staged.push({ id: newId(), name: file.name, dataUrl });
    } catch (err) {
      rejections.push(err instanceof Error ? err.message : `${file.name}: failed`);
    }
  }
  return { staged, rejections };
}

/// True when a model's input-modality list includes image content.
/// `input` follows the pi-ai catalog convention: ("text" | "image")[].
export function modelSupportsImages(input: string[] | undefined | null): boolean {
  return Array.isArray(input) && input.includes('image');
}

/// Parse a data URL into the pi-ai ImageContent shape for session.prompt().
/// Returns null for malformed inputs (callers skip them server-side).
export function dataUrlToImageContent(
  dataUrl: string,
): { type: 'image'; data: string; mimeType: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const [, mimeType, data] = m;
  if (!mimeType.startsWith('image/') || !data) return null;
  return { type: 'image' as const, data, mimeType };
}

/// Human-readable byte size for preview chips ("412 KB").
export function formatDataUrlSize(dataUrl: string): string {
  const m = /;base64,(.+)$/.exec(dataUrl);
  const bytes = m ? Math.floor((m[1].length * 3) / 4) : 0;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${bytes} B`;
}
