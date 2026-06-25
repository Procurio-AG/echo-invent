"use client";

import { useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import "react-easy-crop/react-easy-crop.css";

type Props = {
  imageSrc: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (croppedAreaPixels: Area) => void;
};

// Full-screen square cropper. Self-contained crop/zoom state; reports the final
// pixel area up via onConfirm so the parent can crop+compress+enqueue.
export function CropModal({ imageSrc, busy, onCancel, onConfirm }: Props) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedArea, setCroppedArea] = useState<Area | null>(null);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg/95">
      <div className="relative flex-1">
        <Cropper
          image={imageSrc}
          crop={crop}
          zoom={zoom}
          aspect={1}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={(_area, areaPixels) => setCroppedArea(areaPixels)}
        />
      </div>
      <div className="flex items-center gap-3 border-t border-border bg-surface p-4">
        <input
          type="range"
          min={1}
          max={3}
          step={0.01}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          className="flex-1"
          aria-label="Zoom"
        />
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-border bg-bg px-4 py-2 text-sm text-text hover:bg-border disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => croppedArea && onConfirm(croppedArea)}
          disabled={busy || !croppedArea}
          className="rounded-md border border-border bg-text px-5 py-2 text-sm font-medium text-bg hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Processing…" : "Use photo"}
        </button>
      </div>
    </div>
  );
}
