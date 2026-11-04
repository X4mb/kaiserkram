/** Foundry's file browser and uploads, shared by the import and the re-cutting of pictures. */

type Picker = {
  browse(source: string, target: string, options?: Record<string, unknown>): Promise<{ files: string[]; target: string }>;
  upload(source: string, path: string, file: File, body?: unknown, options?: Record<string, unknown>): Promise<{ path?: string } | false | void>;
  createDirectory(source: string, target: string, options?: Record<string, unknown>): Promise<unknown>;
};
export type PickerCtor = (new (options: Record<string, unknown>) => { render(force?: boolean): unknown }) & Picker;

export function filePicker(): PickerCtor {
  return (foundry.applications as unknown as { apps: { FilePicker: { implementation: PickerCtor } } }).apps.FilePicker.implementation;
}

export function route(path: string): string {
  const getRoute = (foundry.utils as unknown as { getRoute?(p: string): string }).getRoute;
  return getRoute ? getRoute(path) : `/${path}`;
}

export function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}

/** Make `path` (and its parents) under the user data folder; existing folders are fine. */
export async function ensureFolder(path: string): Promise<void> {
  let current = '';
  for (const part of path.split('/')) {
    current = current ? `${current}/${part}` : part;
    try {
      await filePicker().createDirectory('data', current, { notify: false });
    } catch {
      // Already there (or not ours to make): the upload says so if it really can't go there.
    }
  }
}

/** Upload `file` into `folder`; the path Foundry stored it under. */
export async function upload(folder: string, file: File): Promise<string> {
  const result = await filePicker().upload('data', folder, file, {}, { notify: false });
  return (result && result.path) || `${folder}/${file.name}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${src}`));
    img.src = src;
  });
}

/**
 * The picture with everything outside `polygons` made transparent. `polygons` are in scene
 * pixels ([x0, y0, x1, y1, …]); holes cut back out (even-odd), as region polygons come.
 */
export async function cutPicture(source: string | Blob, sceneWidth: number, sceneHeight: number, polygons: number[][]): Promise<Blob> {
  const url = typeof source === 'string' ? route(source) : URL.createObjectURL(source);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2D canvas');
    const sx = img.naturalWidth / sceneWidth;
    const sy = img.naturalHeight / sceneHeight;
    ctx.beginPath();
    for (const points of polygons) {
      for (let i = 0; i + 1 < points.length; i += 2) {
        const x = points[i] * sx;
        const y = points[i + 1] * sy;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
    ctx.clip('evenodd');
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('could not encode the picture'))), 'image/webp', 0.9),
    );
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(url);
  }
}
