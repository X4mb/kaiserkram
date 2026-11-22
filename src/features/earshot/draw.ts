/** Drawing shared by the voice dot, speaking rings and whisper badges on the token layer. */

type Drawable = PIXI.Graphics & Record<string, unknown>;
type V8 = {
  circle(x: number, y: number, r: number): void;
  fill(o: { color: number; alpha: number }): void;
  stroke(o: { width: number; color: number; alpha: number }): void;
};
type V7 = {
  beginFill(c: number, a?: number): void;
  lineStyle(width: number, color: number, alpha: number): void;
  drawCircle(x: number, y: number, r: number): void;
  endFill(): void;
};

/** PIXI v8 draws a shape then fills it; v7 begins a fill first. Support whichever Foundry ships. */
function isV8(g: PIXI.Graphics): boolean {
  const gfx = g as Drawable;
  return typeof gfx.circle === 'function' && typeof gfx.fill === 'function';
}

export function fillCircle(g: PIXI.Graphics, x: number, y: number, r: number, color: number): void {
  if (isV8(g)) {
    const v8 = g as unknown as V8;
    v8.circle(x, y, r);
    v8.fill({ color, alpha: 1 });
    return;
  }
  const v7 = g as unknown as V7;
  v7.beginFill(color, 1);
  v7.drawCircle(x, y, r);
  v7.endFill();
}

export function strokeCircle(g: PIXI.Graphics, x: number, y: number, r: number, width: number, color: number): void {
  if (isV8(g)) {
    const v8 = g as unknown as V8;
    v8.circle(x, y, r);
    v8.stroke({ width, color, alpha: 1 });
    return;
  }
  const v7 = g as unknown as V7;
  v7.lineStyle(width, color, 1);
  v7.drawCircle(x, y, r);
}

/** Reused every frame instead of a new point per drawing (made on first use, not at load). */
let scratch: PIXI.Point | null = null;

/** Where `token`'s top-left corner is in `layer`'s coordinates (follows movement animation). */
export function positionIn(layer: PIXI.Container, token: Token): PIXI.Point {
  scratch ??= new PIXI.Point();
  token.getGlobalPosition(scratch);
  return layer.toLocal(scratch, undefined, scratch);
}
