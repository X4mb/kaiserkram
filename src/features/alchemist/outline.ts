/**
 * The outline of a building on one floor, worked out from its walls: everything that can be
 * reached from the edge of the map without crossing a wall is outside, the rest (rooms, the
 * walls themselves and a small margin) is the building. Pure geometry on a coarse grid, so it can
 * be tested on its own.
 */

export type OutlineOptions = {
  /** Size of one grid cell in pixels; finer follows diagonal walls better, coarser is faster. */
  cell: number;
  /** Cells added around every wall: closes small gaps between wall pieces and keeps the eaves. */
  grow: number;
  /** Building parts smaller than this many cells are dropped (a lone post outside). */
  minCells: number;
};

type Segment = number[];

/** Polygons ([x0, y0, x1, y1, …] in pixels) around everything inside the walls. */
export function outlineFromWalls(width: number, height: number, walls: Segment[], options: OutlineOptions): number[][] {
  const { cell, grow, minCells } = options;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const index = (cx: number, cy: number) => cy * cols + cx;

  // 1. Cells a wall passes through, grown by `grow` cells.
  const wall = new Uint8Array(cols * rows);
  for (const [x0, y0, x1, y1] of walls) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (cell / 2)));
    for (let i = 0; i <= steps; i++) {
      const cx = Math.floor((x0 + ((x1 - x0) * i) / steps) / cell);
      const cy = Math.floor((y0 + ((y1 - y0) * i) / steps) / cell);
      for (let dy = -grow; dy <= grow; dy++) {
        for (let dx = -grow; dx <= grow; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && y >= 0 && x < cols && y < rows) wall[index(x, y)] = 1;
        }
      }
    }
  }

  // 2. Outside: flood from the border through cells without a wall.
  const outside = new Uint8Array(cols * rows);
  const queue: number[] = [];
  const visit = (x: number, y: number) => {
    const i = index(x, y);
    if (wall[i] || outside[i]) return;
    outside[i] = 1;
    queue.push(i);
  };
  for (let x = 0; x < cols; x++) {
    visit(x, 0);
    visit(x, rows - 1);
  }
  for (let y = 0; y < rows; y++) {
    visit(0, y);
    visit(cols - 1, y);
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const x = i % cols;
    const y = (i - x) / cols;
    if (x > 0) visit(x - 1, y);
    if (x < cols - 1) visit(x + 1, y);
    if (y > 0) visit(x, y - 1);
    if (y < rows - 1) visit(x, y + 1);
  }

  // 3. Inside = not outside; drop tiny parts.
  const inside = new Uint8Array(cols * rows);
  for (let i = 0; i < inside.length; i++) inside[i] = outside[i] ? 0 : 1;
  const seen = new Uint8Array(cols * rows);
  for (let start = 0; start < inside.length; start++) {
    if (!inside[start] || seen[start]) continue;
    const part: number[] = [start];
    seen[start] = 1;
    for (let q = 0; q < part.length; q++) {
      const i = part[q];
      const x = i % cols;
      const y = (i - x) / cols;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = index(nx, ny);
        if (inside[n] && !seen[n]) {
          seen[n] = 1;
          part.push(n);
        }
      }
    }
    if (part.length < minCells) for (const i of part) inside[i] = 0;
  }

  return traceOutlines(inside, cols, rows, cell, width, height);
}

/**
 * The boundaries between inside and outside cells, as closed polygons along the cell edges,
 * with straight runs merged. Each outline is walked with the inside on its left.
 */
function traceOutlines(inside: Uint8Array, cols: number, rows: number, cell: number, width: number, height: number): number[][] {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows && inside[y * cols + x] === 1;
  // Directed boundary edges keyed by their start corner: corner (x, y) is the top-left of cell (x, y).
  const edges = new Map<string, [number, number][]>();
  const add = (ax: number, ay: number, bx: number, by: number) => {
    const key = `${ax},${ay}`;
    const list = edges.get(key) ?? [];
    list.push([bx, by]);
    edges.set(key, list);
  };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) add(x, y, x + 1, y); // top, walking right
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1); // right, walking down
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1); // bottom, walking left
      if (!at(x - 1, y)) add(x, y + 1, x, y); // left, walking up
    }
  }

  const polygons: number[][] = [];
  for (const [startKey, list] of edges) {
    while (list.length) {
      const [sx, sy] = startKey.split(',').map(Number);
      const loop: [number, number][] = [[sx, sy]];
      let [nx, ny] = list.pop()!;
      let [px, py] = [sx, sy];
      while (!(nx === sx && ny === sy)) {
        loop.push([nx, ny]);
        const next = edges.get(`${nx},${ny}`);
        if (!next?.length) break;
        // At a corner touching two parts, keep turning the same way so loops don't cross.
        const dir = [nx - px, ny - py];
        let pick = 0;
        if (next.length > 1) {
          const left = [dir[1], -dir[0]];
          const found = next.findIndex(([qx, qy]) => qx - nx === left[0] && qy - ny === left[1]);
          if (found >= 0) pick = found;
        }
        const [qx, qy] = next.splice(pick, 1)[0];
        [px, py] = [nx, ny];
        [nx, ny] = [qx, qy];
      }
      const points = simplify(loop);
      if (points.length >= 3) {
        polygons.push(points.flatMap(([x, y]) => [Math.min(width, x * cell), Math.min(height, y * cell)]));
      }
    }
  }
  return polygons;
}

/** Drop corners in the middle of straight runs. */
function simplify(loop: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = loop[(i - 1 + n) % n];
    const [bx, by] = loop[i];
    const [cx, cy] = loop[(i + 1) % n];
    if ((bx - ax) * (cy - by) - (by - ay) * (cx - bx) !== 0) out.push([bx, by]);
  }
  return out;
}
