import sharp from 'sharp';

export type Point = [number, number];
export type Triangle = [number, number, number];
export type Landmark = { intent: 'preserve' | 'densify'; uv: Point };
export type Slice = { width: number; height: number; alpha: Uint8Array };
export type MeshGeometry = { points: Point[]; triangles: Triangle[]; hull: number };

const EPS = 1e-7;
const side = (a: Point, b: Point, p: Point) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
const dist2 = (a: Point, b: Point) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

export async function readSlice(file: string): Promise<Slice> {
  const image = sharp(file, { limitInputPixels: 16_777_216 });
  const metadata = await image.metadata();
  if (metadata.format !== 'png' || !metadata.hasAlpha || (metadata.pages ?? 1) !== 1) {
    throw new Error('切片必须是单帧、带 alpha 通道的 PNG。');
  }
  const { data, info } = await image.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = new Uint8Array(info.width * info.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * info.channels + 3];
  if (!alpha.some(Boolean)) throw new Error('切片没有可见像素。');
  return { width: info.width, height: info.height, alpha };
}

export function parseLandmarks(value: unknown): Landmark[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('地标必须是数组，最多 64 项。');
  return value.map(item => {
    if (!item || !['preserve', 'densify'].includes(item.intent) || !Array.isArray(item.uv) ||
        item.uv.length !== 2 || !item.uv.every((v: unknown) => typeof v === 'number' && v >= 0 && v <= 1)) {
      throw new Error('地标须提供 intent 与 [0, 1] 范围内的二维 uv。');
    }
    return { intent: item.intent, uv: [item.uv[0], item.uv[1]] };
  });
}

function dilate(slice: Slice, padding: number): Uint8Array {
  const { width, height, alpha } = slice;
  const horizontal = new Uint8Array(alpha.length);
  const result = new Uint8Array(alpha.length);
  for (let y = 0; y < height; y++) {
    let count = 0;
    const row = y * width;
    for (let x = -padding; x < width; x++) {
      if (x + padding < width && alpha[row + x + padding]) count++;
      if (x - padding - 1 >= 0 && alpha[row + x - padding - 1]) count--;
      if (x >= 0) horizontal[row + x] = Number(count > 0);
    }
  }
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = -padding; y < height; y++) {
      if (y + padding < height && horizontal[(y + padding) * width + x]) count++;
      if (y - padding - 1 >= 0 && horizontal[(y - padding - 1) * width + x]) count--;
      if (y >= 0) result[y * width + x] = Number(count > 0);
    }
  }
  return result;
}

function exterior(mask: Uint8Array, width: number, height: number): Point[] {
  const stride = width + 1;
  const links = new Map<number, number[]>();
  function add(a: number, b: number) {
    const edges = links.get(a);
    if (edges) edges.push(b);
    else links.set(a, [b]);
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x;
    if (!mask[p]) continue;
    const a = y * stride + x;
    if (!y || !mask[p - width]) add(a, a + 1);
    if (x === width - 1 || !mask[p + 1]) add(a + 1, a + stride + 1);
    if (y === height - 1 || !mask[p + width]) add(a + stride + 1, a + stride);
    if (!x || !mask[p - 1]) add(a + stride, a);
  }
  const point = (n: number): Point => [n % stride, Math.floor(n / stride)];
  let largest: Point[] = [];
  let largestArea = 0;
  for (const start of links.keys()) {
    let p = start;
    let previous = start;
    let area = 0;
    const ring: Point[] = [];
    do {
      const list = links.get(p);
      if (!list) break;
      const a = point(p);
      const last = point(previous);
      // At diagonal contact choose the right turn along the same component.
      const index = list.length === 2 && side(last, a, point(list[1])) > side(last, a, point(list[0])) ? 1 : 0;
      const [next] = list.splice(index, 1);
      if (!list.length) links.delete(p);
      const b = point(next);
      ring.push(a);
      area += a[0] * b[1] - b[0] * a[1];
      previous = p;
      p = next;
    } while (p !== start);
    if (p === start && area > largestArea) {
      largest = ring;
      largestArea = area;
    }
  }
  return largest;
}

function simplified(ring: Point[], landmarks: Landmark[], width: number, height: number, epsilon: number): Point[] {
  const fixed = new Set([0, Math.floor(ring.length / 2)]);
  for (const { intent, uv } of landmarks) if (intent === 'preserve') {
    const p: Point = [uv[0] * width, uv[1] * height];
    let best = 0;
    for (let i = 1; i < ring.length; i++) if (dist2(ring[i], p) < dist2(ring[best], p)) best = i;
    fixed.add(best);
  }
  const stops = [...fixed].sort((a, b) => a - b);
  const keep = new Set(stops);
  const pending = stops.map((index, i) => [index, stops[i + 1] ?? ring.length]);
  while (pending.length) {
    const [i, j] = pending.pop()!;
    const a = ring[i], b = ring[j % ring.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], length = dist2(a, b);
    let max = epsilon ** 2, split = i;
    for (let k = i + 1; k < j; k++) {
      const p = ring[k];
      const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
      const error = dist2(p, [a[0] + t * dx, a[1] + t * dy]);
      if (error > max) {
        split = k;
        max = error;
      }
    }
    if (split !== i) {
      keep.add(split);
      pending.push([i, split], [split, j]);
    }
  }
  return [...keep].sort((a, b) => a - b).map(i => ring[i]);
}

function covers(slice: Slice, hull: Point[]): boolean {
  for (let y = 0; y < slice.height; y++) {
    const intersections: number[] = [];
    const py = y + .5;
    hull.forEach((a, i) => {
      const b = hull[(i + 1) % hull.length];
      if ((a[1] > py) !== (b[1] > py)) intersections.push(a[0] + (py - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    });
    intersections.sort((a, b) => a - b);
    let interval = 0;
    for (let x = 0; x < slice.width; x++) {
      if (!slice.alpha[y * slice.width + x]) continue;
      const px = x + .5;
      while (interval < intersections.length && px > intersections[interval + 1] + EPS) interval += 2;
      if (interval >= intersections.length || px < intersections[interval] - EPS) return false;
    }
  }
  return true;
}

function triangulate(hull: Point[]): Triangle[] {
  const pending = hull.map((_, i) => i);
  const triangles: Triangle[] = [];
  while (pending.length > 3) {
    const index = pending.findIndex((b, i) => {
      const a = pending[(i + pending.length - 1) % pending.length], c = pending[(i + 1) % pending.length];
      return side(hull[a], hull[b], hull[c]) > EPS && !pending.some(p => p !== a && p !== b && p !== c &&
        side(hull[a], hull[b], hull[p]) >= -EPS && side(hull[b], hull[c], hull[p]) >= -EPS &&
        side(hull[c], hull[a], hull[p]) >= -EPS);
    });
    if (index < 0) throw new Error('轮廓无法形成简单多边形。');
    triangles.push([pending[(index + pending.length - 1) % pending.length], pending[index], pending[(index + 1) % pending.length]]);
    pending.splice(index, 1);
  }
  triangles.push([pending[0], pending[1], pending[2]]);
  return triangles;
}

function weights(a: Point, b: Point, c: Point, p: Point): [number, number, number] {
  const area = side(a, b, c);
  const u = side(b, c, p) / area, v = side(c, a, p) / area;
  return [u, v, 1 - u - v];
}

export function meshLookup(points: Point[], triangles: Triangle[], width: number, height: number) {
  const block = 24;
  const cells: Triangle[][] = Array.from({ length: block * block }, () => []);
  const xbin = (x: number) => Math.max(0, Math.min(block - 1, Math.floor(x * block / width)));
  const ybin = (y: number) => Math.max(0, Math.min(block - 1, Math.floor(y * block / height)));
  for (const tri of triangles) {
    const [a, b, c] = tri.map(i => points[i]);
    for (let y = ybin(Math.min(a[1], b[1], c[1])); y <= ybin(Math.max(a[1], b[1], c[1])); y++) {
      for (let x = xbin(Math.min(a[0], b[0], c[0])); x <= xbin(Math.max(a[0], b[0], c[0])); x++) cells[y * block + x].push(tri);
    }
  }
  return (p: Point) => {
    for (const tri of cells[ybin(p[1]) * block + xbin(p[0])]) {
      const parts = weights(points[tri[0]], points[tri[1]], points[tri[2]], p);
      if (Math.min(...parts) >= -EPS) return { tri, parts };
    }
    return undefined;
  };
}

export function insertPoint(mesh: MeshGeometry, p: Point, spacing: number): boolean {
  const { points, triangles } = mesh;
  if (points.some(q => dist2(p, q) < spacing ** 2)) return false;
  const i = triangles.findIndex(([a, b, c]) => Math.min(...weights(points[a], points[b], points[c], p)) >= -EPS);
  if (i < 0) return false;
  const tri = triangles[i];
  const parts = weights(points[tri[0]], points[tri[1]], points[tri[2]], p);
  const cut = parts.indexOf(Math.min(...parts));
  const a = tri[cut], b = tri[(cut + 1) % 3], c = tri[(cut + 2) % 3];
  const n = points.length;
  if (parts[cut] > EPS) {
    triangles[i] = [a, b, n];
    triangles.push([b, c, n], [c, a, n]);
  } else {
    const opposite = triangles.findIndex((t, j) => j !== i && t.includes(b) && t.includes(c));
    if (opposite < 0) return false;
    const d = triangles[opposite].find(v => v !== b && v !== c)!;
    triangles[i] = [a, b, n];
    triangles[opposite] = [d, c, n];
    triangles.push([a, n, c], [d, n, b]);
  }
  points.push(p);
  return true;
}

export function improveTriangles(mesh: MeshGeometry): void {
  const { points, triangles } = mesh;
  const name = (a: number, b: number) => a < b ? a * points.length + b : b * points.length + a;
  const edges = ([a, b, c]: Triangle) => [name(a, b), name(b, c), name(c, a)];
  const adjacency = new Map<number, Set<number>>();
  const add = (key: number, i: number) => {
    if (!adjacency.has(key)) adjacency.set(key, new Set());
    adjacency.get(key)!.add(i);
  };
  triangles.forEach((t, i) => edges(t).forEach(key => add(key, i)));
  const pending = [...adjacency.keys()];
  let steps = pending.length * 40;
  while (pending.length && steps-- > 0) {
    const key = pending.pop()!, pair = adjacency.get(key)!;
    if (pair.size !== 2) continue;
    const [i, j] = pair;
    let a = Math.floor(key / points.length), b = key % points.length;
    const c = triangles[i].find(k => k !== a && k !== b)!, d = triangles[j].find(k => k !== a && k !== b)!;
    if (side(points[a], points[b], points[c]) < 0) [a, b] = [b, a];
    if (side(points[c], points[a], points[d]) <= EPS || side(points[d], points[b], points[c]) <= EPS) continue;
    const p = points[d];
    const [u, v, w] = [a, b, c].map((id): Point => [points[id][0] - p[0], points[id][1] - p[1]]);
    const zero: Point = [0, 0];
    const test = dist2(u, zero) * side(zero, v, w) - dist2(v, zero) * side(zero, u, w) + dist2(w, zero) * side(zero, u, v);
    if (test <= EPS) continue;
    for (const idx of [i, j]) edges(triangles[idx]).forEach(k => adjacency.get(k)!.delete(idx));
    triangles[i] = [c, a, d];
    triangles[j] = [d, b, c];
    for (const idx of [i, j]) for (const k of edges(triangles[idx])) {
      add(k, idx);
      pending.push(k);
    }
  }
  if (pending.length) throw new Error('约束三角化未收敛。');
}

export function createGeometry(slice: Slice, landmarks: Landmark[] = [], weighted = false): MeshGeometry {
  const { width, height } = slice;
  const longest = Math.max(width, height);
  const epsilon = Math.max(.65, longest * .004);
  let mesh: MeshGeometry | undefined;
  for (const padding of [2, 3, 4, 5, 7].map(n => Math.max(1, Math.round(n * Math.max(.35, longest / 360))))) {
    const ring = exterior(dilate(slice, padding), width, height);
    if (ring.length < 4) continue;
    for (const tolerance of [epsilon, epsilon * .65, epsilon * .4]) {
      const points = simplified(ring, landmarks, width, height, tolerance);
      if (points.length < 3 || points.length > 1800 ||
          new Set(points.map(p => p.join(','))).size !== points.length || !covers(slice, points)) continue;
      try {
        mesh = { points, triangles: triangulate(points), hull: points.length };
        break;
      } catch {
        // 更精细的轮廓可能分开因简化而重叠的边。
      }
    }
    if (mesh) break;
  }
  if (!mesh) throw new Error('单一轮廓无法可靠覆盖所有可见像素。');
  const spacing = Math.max(3, longest * (weighted ? .20 : .12));
  const seed = (x: number, y: number, distance: number) => {
    if (x >= 0 && x < width && y >= 0 && y < height && slice.alpha[Math.floor(y) * width + Math.floor(x)] >= 128) {
      insertPoint(mesh!, [x, y], distance);
    }
  };
  for (let y = spacing / 2, row = 0; y < height; y += spacing, row++) {
    for (let x = spacing * (row % 2 ? .85 : .5); x < width; x += spacing) seed(x, y, spacing * .48);
  }
  for (const { intent, uv } of landmarks) if (intent === 'densify') {
    const span = Math.max(2, longest * .02), [x, y] = [uv[0] * width, uv[1] * height];
    for (const [dx, dy] of [[0, 0], [-span, 0], [span, 0], [0, -span], [0, span]]) seed(x + dx, y + dy, span * .52);
  }
  improveTriangles(mesh);
  verifyGeometry(mesh, slice);
  return mesh;
}

export function verifyGeometry(mesh: MeshGeometry, slice: Slice): void {
  const { points, triangles, hull } = mesh;
  if (hull < 3 || hull > points.length || points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) ||
      x < 0 || y < 0 || x > slice.width || y > slice.height) ||
      triangles.length !== 2 * points.length - hull - 2 || triangles.some(t => t.some(i => !Number.isInteger(i) || !points[i]) ||
        side(points[t[0]], points[t[1]], points[t[2]]) <= EPS)) {
    throw new Error('网格三角索引、绕序或顶点坐标无效。');
  }
  const counts = new Map<string, number>();
  const edge = (a: number, b: number) => a < b ? a + ',' + b : b + ',' + a;
  for (const [a, b, c] of triangles) for (const key of [edge(a, b), edge(b, c), edge(c, a)]) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const boundary = new Set(Array.from({ length: hull }, (_, i) => edge(i, (i + 1) % hull)));
  if ([...boundary].some(e => !counts.has(e)) || [...counts].some(([e, count]) => count !== (boundary.has(e) ? 1 : 2))) {
    throw new Error('网格边线与外轮廓拓扑不匹配。');
  }
  if (!covers(slice, points.slice(0, hull))) throw new Error('候选网格漏掉可见像素。');
}

export async function writeOverlay(source: string, mesh: MeshGeometry, slice: Slice, out: string): Promise<void> {
  const { width, height } = slice;
  const stroke = Math.max(.6, Math.max(width, height) / 650);
  const line = (indices: number[]) => indices.map(i => mesh.points[i].join(',')).join(' ');
  const triangles = mesh.triangles.map(t => '<polygon points="' + line(t) + '"/>').join('');
  const hull = line(Array.from({ length: mesh.hull }, (_, i) => i));
  const dots = mesh.points.map(([x, y], i) => '<circle cx="' + x + '" cy="' + y + '" r="' + stroke * 1.55 +
    '" fill="' + (i < mesh.hull ? '#98eed6' : '#ffda75') + '"/>').join('');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
    '"><g fill="none" stroke="#cae6ff" stroke-opacity=".5" stroke-width="' + stroke + '">' + triangles +
    '</g><polygon points="' + hull + '" fill="none" stroke="#98eed6" stroke-width="' + stroke * 1.8 + '"/>' + dots + '</svg>';
  await sharp(source).flatten({ background: '#122f46' }).composite([{ input: Buffer.from(svg) }]).png().toFile(out);
}
