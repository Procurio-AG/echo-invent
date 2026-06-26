// Crop a picked photo to the selected region and compress it to <= 2MB JPEG before
// it ever touches the network. Runs entirely on a <canvas>, no dependencies. The
// server also enforces 2MB, but compressing here keeps the Tailscale upload small.

export type CroppedArea = { x: number; y: number; width: number; height: number };

const MAX_BYTES = 2 * 1024 * 1024; // 2MB hard ceiling
const MAX_EDGE = 1600; // cap the long edge; keeps typical photos ~300-600KB

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Canvas encode failed."))),
      "image/jpeg",
      quality
    );
  });
}

export async function cropAndCompress(
  file: File,
  area: CroppedArea
): Promise<Blob> {
  // `from-image` applies EXIF orientation so the crop matches what was shown.
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  }).catch(() => createImageBitmap(file));

  let scale = Math.min(1, MAX_EDGE / Math.max(area.width, area.height));

  // Outer loop downscales the canvas if quality reduction alone can't hit 2MB.
  for (let pass = 0; pass < 4; pass++) {
    const w = Math.max(1, Math.round(area.width * scale));
    const h = Math.max(1, Math.round(area.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unsupported.");
    ctx.drawImage(bitmap, area.x, area.y, area.width, area.height, 0, 0, w, h);

    let quality = 0.9;
    let blob = await toBlob(canvas, quality);
    while (blob.size > MAX_BYTES && quality > 0.4) {
      quality -= 0.1;
      blob = await toBlob(canvas, quality);
    }
    if (blob.size <= MAX_BYTES) {
      bitmap.close?.();
      return blob;
    }
    scale *= 0.75; // shrink and retry
  }

  bitmap.close?.();
  throw new Error("Could not compress image under 2MB.");
}
