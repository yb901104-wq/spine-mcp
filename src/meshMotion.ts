import {
  createGeometry, improveTriangles, insertPoint, meshLookup, verifyGeometry,
  type Landmark, type MeshGeometry, type Point, type Slice, type Triangle,
} from './meshGeometry.js';

export type WeightedMesh = {
  type: 'mesh'; path?: string; width: number; height: number; hull: number;
  uvs: number[]; vertices: number[]; triangles: number[]; edges?: number[];
};
type Key = { time?: number; value?: number; x?: number; y?: number; curve?: number[] | 'stepped' };
type Bone = {
  name: string; parent?: string; x?: number; y?: number; rotation?: number;
  scaleX?: number; scaleY?: number; shearX?: number; shearY?: number; inherit?: string;
};
type Tracks = Record<string, Record<string, Key[]>>;
type Matrix = [number, number, number, number, number, number];
type Contribution = [number, number, number, number];
export type Weights = Contribution[][];
type Pose = { animation: string | null; time: number; matrices: Matrix[] };
export type MotionReport = { samples: number; animations: number; tolerancePx: number; maximumDeviationPx: number; flippedTriangles: number };
export class UnsupportedMeshError extends Error {}

const RADIANS = Math.PI / 180;

export function decodeWeights(mesh: WeightedMesh, boneCount: number): Weights {
  const values = mesh.vertices;
  const count = mesh.uvs.length / 2;
  const result: Weights = [];
  let i = 0;
  if (!Number.isInteger(count) || count < 3 || values.length === mesh.uvs.length) {
    throw new UnsupportedMeshError('目标必须是已有骨骼权重的 Mesh。');
  }
  for (let vertex = 0; vertex < count; vertex++) {
    const total = values[i++];
    if (!Number.isInteger(total) || total < 1 || total > boneCount) throw new Error('Mesh 权重索引无效。');
    const influences: Contribution[] = [];
    let sum = 0;
    for (let j = 0; j < total; j++) {
      const [bone, x, y, weight] = values.slice(i, i + 4);
      i += 4;
      if (!Number.isInteger(bone) || bone < 0 || bone >= boneCount || ![x, y, weight].every(Number.isFinite) ||
          weight < 0 || influences.some(item => item[0] === bone)) throw new Error('Mesh 权重值或骨骼引用无效。');
      if (weight > 0) influences.push([bone, x * weight, y * weight, weight]);
      sum += weight;
    }
    if (Math.abs(sum - 1) > .001) throw new Error('原 Mesh 权重总和不是 1。');
    result.push(influences);
  }
  if (i !== values.length) throw new Error('Mesh 权重长度与 UV 不符。');
  return result;
}

export function geometryFromAttachment(mesh: WeightedMesh, slice: Slice): MeshGeometry {
  if (mesh.width !== slice.width || mesh.height !== slice.height) throw new Error('源 PNG 尺寸与 Mesh 尺寸不一致。');
  const points: Point[] = [], triangles: Triangle[] = [];
  for (let i = 0; i < mesh.uvs.length; i += 2) points.push([mesh.uvs[i] * slice.width, mesh.uvs[i + 1] * slice.height]);
  for (let i = 0; i < mesh.triangles.length; i += 3) triangles.push([mesh.triangles[i], mesh.triangles[i + 1], mesh.triangles[i + 2]]);
  return { points, triangles, hull: mesh.hull };
}

export function interpolateWeights(lookup: ReturnType<typeof meshLookup>, source: Weights, points: Point[]): Weights {
  return points.map(point => {
    const match = lookup(point);
    if (!match) throw new Error('新顶点无法在原 Mesh UV 三角形中定位。');
    const interpolated = new Map<number, Contribution>();
    match.tri.forEach((index, i) => {
      for (const [bone, x, y, weight] of source[index]) {
        const factor = Math.max(0, match.parts[i]);
        const previous = interpolated.get(bone) ?? [bone, 0, 0, 0];
        previous[1] += x * factor;
        previous[2] += y * factor;
        previous[3] += weight * factor;
        interpolated.set(bone, previous);
      }
    });
    const influences = [...interpolated.values()].filter(item => item[3] >= 1e-6).sort((a, b) => a[0] - b[0]);
    const total = influences.reduce((n, item) => n + item[3], 0);
    if (total <= 0) throw new Error('无法转移新顶点权重。');
    return influences.map(([bone, x, y, w]) => [bone, x / total, y / total, w / total]);
  });
}

function bezier(a: number, b: number, c: number, d: number, t: number) {
  const p = 1 - t;
  return p ** 3 * a + 3 * p * p * t * b + 3 * p * t * t * c + t ** 3 * d;
}

function evaluate(keys: Key[] | undefined, time: number, axis: 'value' | 'x' | 'y', initial: number, part = 0): number {
  if (!keys?.length || time < (keys[0].time ?? 0)) return initial;
  for (let i = 0; i < keys.length - 1; i++) {
    const [first, next] = [keys[i], keys[i + 1]];
    const a = first.time ?? 0, b = next.time ?? 0;
    if (time >= b) continue;
    const y0 = first[axis] ?? initial, y1 = next[axis] ?? initial;
    if (first.curve === 'stepped') return y0;
    if (!first.curve) return y0 + (y1 - y0) * (time - a) / (b - a);
    const [x1, c1, x2, c2] = first.curve.slice(part * 4, (part + 1) * 4);
    let lo = 0, hi = 1;
    for (let step = 0; step < 22; step++) {
      const t = (lo + hi) / 2;
      if (bezier(a, x1, x2, b, t) < time) lo = t;
      else hi = t;
    }
    return bezier(y0, c1, c2, y1, (lo + hi) / 2);
  }
  return keys[keys.length - 1][axis] ?? initial;
}

function compose(p: Matrix, l: Matrix): Matrix {
  return [
    p[0] * l[0] + p[1] * l[3], p[0] * l[1] + p[1] * l[4], p[0] * l[2] + p[1] * l[5] + p[2],
    p[3] * l[0] + p[4] * l[3], p[3] * l[1] + p[4] * l[4], p[3] * l[2] + p[4] * l[5] + p[5],
  ];
}

function matrices(bones: Bone[], tracks: Tracks, time: number): Matrix[] {
  const world = new Map<string, Matrix>();
  for (const bone of bones) {
    const t = tracks[bone.name] ?? {};
    const rotation = (bone.rotation ?? 0) + evaluate(t.rotate, time, 'value', 0);
    const sx = (bone.scaleX ?? 1) * evaluate(t.scale, time, 'x', 1);
    const sy = (bone.scaleY ?? 1) * evaluate(t.scale, time, 'y', 1, 1);
    const rx = (rotation + (bone.shearX ?? 0) + evaluate(t.shear, time, 'x', 0)) * RADIANS;
    const ry = (rotation + 90 + (bone.shearY ?? 0) + evaluate(t.shear, time, 'y', 0, 1)) * RADIANS;
    const x = (bone.x ?? 0) + evaluate(t.translate, time, 'x', 0);
    const y = (bone.y ?? 0) + evaluate(t.translate, time, 'y', 0, 1);
    const local: Matrix = [Math.cos(rx) * sx, Math.cos(ry) * sy, x, Math.sin(rx) * sx, Math.sin(ry) * sy, y];
    const parent = bone.parent ? world.get(bone.parent) : undefined;
    if (bone.parent && !parent) throw new Error('骨骼父子顺序无法求值。');
    world.set(bone.name, parent ? compose(parent, local) : local);
  }
  return [...world.values()];
}

const COMMON_TRACKS = new Set(['rotate', 'translate', 'scale', 'shear']);
export function samplePoses(model: Record<string, any>): Pose[] {
  const bones = model.bones as Bone[];
  if (!Array.isArray(bones) || !bones.length || bones.some(b => b.inherit && b.inherit !== 'normal')) {
    throw new UnsupportedMeshError('仅支持标准继承的普通骨骼。');
  }
  if (['constraints', 'ik', 'transform', 'path', 'physics', 'slider'].some(key => Object.keys(model[key] ?? {}).length)) {
    throw new UnsupportedMeshError('工程含需额外求值的约束。');
  }
  const names = new Set(bones.map(b => b.name));
  if (names.size !== bones.length) throw new Error('骨骼名称重复。');
  const poses: Pose[] = [{ animation: null, time: 0, matrices: matrices(bones, {}, 0) }];
  for (const [animation, motion] of Object.entries(model.animations ?? {}) as [string, Record<string, any>][]) {
    if (['attachments', 'deform'].some(key => Object.keys(motion[key] ?? {}).length)) {
      throw new UnsupportedMeshError('动画 ' + animation + ' 含 deform 或附件 Mesh 时间线。');
    }
    const tracks: Tracks = motion.bones ?? {};
    const times = new Set([0]);
    for (const [name, boneTracks] of Object.entries(tracks)) for (const [kind, keys] of Object.entries(boneTracks)) {
      if (!names.has(name) || !COMMON_TRACKS.has(kind) || !Array.isArray(keys)) {
        throw new UnsupportedMeshError('动画 ' + animation + ' 含不支持的骨骼时间线 ' + kind + '。');
      }
      let previous = -1;
      for (const [i, k] of keys.entries()) {
        const time = k.time ?? 0;
        if (!Number.isFinite(time) || time < 0 || time <= previous || (Array.isArray(k.curve) &&
            (i === keys.length - 1 || k.curve.length !== (kind === 'rotate' ? 4 : 8) || !k.curve.every(Number.isFinite)))) {
          throw new Error('动画 ' + animation + ' 中有无法求值的时间或曲线。');
        }
        times.add(time);
        if (previous >= 0) times.add((previous + time) / 2);
        previous = time;
      }
    }
    const duration = Math.max(...times);
    const frames = Math.ceil(duration * 60);
    if (poses.length + times.size + frames > 6000) throw new Error('动画采样超过首版支持的 6000 帧。');
    for (let i = 1; i <= frames; i++) times.add(i / frames * duration);
    for (const time of [...times].sort((a, b) => a - b)) poses.push({ animation, time, matrices: matrices(bones, tracks, time) });
  }
  return poses;
}

function position(influences: Contribution[], matricesForPose: Matrix[]): Point {
  let x = 0, y = 0;
  for (const [bone, wx, wy, w] of influences) {
    const m = matricesForPose[bone];
    x += m[0] * wx + m[1] * wy + m[2] * w;
    y += m[3] * wx + m[4] * wy + m[5] * w;
  }
  return [x, y];
}

function samples(slice: Slice, step: number): Point[] {
  const result: Point[] = [];
  for (let y = 0; y < slice.height; y += step) for (let x = 0; x < slice.width; x += step) {
    if (slice.alpha[y * slice.width + x]) result.push([x + .5, y + .5]);
  }
  // Include silhouette samples between raster grid cells.
  for (let y = 0; y < slice.height; y += Math.max(1, Math.floor(step / 2))) {
    for (let x = 0; x < slice.width; x++) {
      const n = y * slice.width + x;
      if (slice.alpha[n] && ((!x || !slice.alpha[n - 1]) || (x + 1 === slice.width || !slice.alpha[n + 1]))) {
        result.push([x + .5, y + .5]);
      }
    }
  }
  return result;
}

function surface(lookup: ReturnType<typeof meshLookup>, point: Point) {
  const match = lookup(point);
  if (!match) throw new Error('检测到可见纹理像素超出 Mesh 三角形。');
  return match;
}

function signedArea(points: Point[], [a, b, c]: Triangle): number {
  return (points[b][0] - points[a][0]) * (points[c][1] - points[a][1]) -
    (points[b][1] - points[a][1]) * (points[c][0] - points[a][0]);
}

function deviations(
  points: Point[], previous: MeshGeometry, original: Weights, next: MeshGeometry, weighted: Weights, slice: Slice, poses: Pose[],
) {
  const oldAt = meshLookup(previous.points, previous.triangles, slice.width, slice.height);
  const nextAt = meshLookup(next.points, next.triangles, slice.width, slice.height);
  const oldSurface = points.map(p => surface(oldAt, p)), newSurface = points.map(p => surface(nextAt, p));
  const errors = new Float64Array(points.length);
  const flipped = new Set<number>();
  for (const pose of poses) {
    const before = original.map(vertex => position(vertex, pose.matrices));
    const after = weighted.map(vertex => position(vertex, pose.matrices));
    const orientation = Math.sign(previous.triangles.reduce((sum, triangle) => sum + signedArea(before, triangle), 0));
    next.triangles.forEach((triangle, index) => {
      const area = signedArea(after, triangle) * orientation;
      if (!Number.isFinite(area) || area <= 1e-8) flipped.add(index);
    });
    for (let i = 0; i < points.length; i++) {
      let dx = 0, dy = 0;
      for (let k = 0; k < 3; k++) {
        const a = before[oldSurface[i].tri[k]], b = after[newSurface[i].tri[k]];
        dx += a[0] * oldSurface[i].parts[k] - b[0] * newSurface[i].parts[k];
        dy += a[1] * oldSurface[i].parts[k] - b[1] * newSurface[i].parts[k];
      }
      errors[i] = Math.max(errors[i], Math.hypot(dx, dy));
    }
  }
  return { errors, flipped };
}

function ensureOldGeometry(mesh: MeshGeometry, slice: Slice) {
  for (const tri of mesh.triangles) {
    if (tri.some(i => !Number.isInteger(i) || !mesh.points[i])) throw new Error('原 Mesh 三角索引无效。');
    const [a, b, c] = tri.map(i => mesh.points[i]);
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (!Number.isFinite(area) || Math.abs(area) < 1e-7) throw new Error('原 Mesh 含退化三角形。');
    if (area < 0) [tri[1], tri[2]] = [tri[2], tri[1]];
  }
  verifyGeometry(mesh, slice);
}

export function optimizeWeightedMesh(mesh: WeightedMesh, slice: Slice, allPoses: Pose[], landmarks: Landmark[]) {
  const previous = geometryFromAttachment(mesh, slice), original = decodeWeights(mesh, allPoses[0].matrices.length);
  ensureOldGeometry(previous, slice);
  const longest = Math.max(slice.width, slice.height), tolerance = Math.max(1, longest * .006);
  const maxVertices = Math.min(1200, previous.points.length - 1);
  const lookup = meshLookup(previous.points, previous.triangles, slice.width, slice.height);
  const next = createGeometry(slice, landmarks, true);
  const probe = samples(slice, Math.max(1, Math.round(longest / 145)));
  // Reserve margin for the editor's float serialization and weight rounding.
  const goal = tolerance * .93;
  const stride = Math.max(1, Math.ceil(allPoses.length / 25));
  const light = allPoses.filter((_, index) => index % stride === 0 || index === allPoses.length - 1);
  const detailed = (weighted: Weights) => deviations(probe, previous, original, next, weighted, slice, allPoses);
  while (next.points.length <= maxVertices) {
    const weighted = interpolateWeights(lookup, original, next.points);
    let result = deviations(probe, previous, original, next, weighted, slice, light);
    if (result.errors.every(value => value <= goal) && !result.flipped.size) {
      result = detailed(weighted);
      if (result.errors.every(value => value <= goal) && !result.flipped.size) {
        verifyGeometry(next, slice);
        return { geometry: next, weights: weighted };
      }
    }
    if (next.points.length === maxVertices) break;
    const add = [...result.flipped].map((i): Point => {
      const [a, b, c] = next.triangles[i].map(j => next.points[j]);
      return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
    });
    const order = [...result.errors.keys()].filter(i => result.errors[i] > goal)
      .sort((a, b) => result.errors[b] - result.errors[a]);
    if (![...add, ...order.map(i => probe[i])].some(p => insertPoint(next, p, Math.max(.9, longest * .003)))) break;
    improveTriangles(next);
  }
  throw new Error('无法在减少顶点的前提下满足形变或三角翻折检查。');
}

export function verifyMotion(oldMesh: WeightedMesh, newMesh: WeightedMesh, slice: Slice, poses: Pose[]): MotionReport {
  const before = geometryFromAttachment(oldMesh, slice), after = geometryFromAttachment(newMesh, slice);
  ensureOldGeometry(before, slice);
  verifyGeometry(after, slice);
  const oldWeights = decodeWeights(oldMesh, poses[0].matrices.length), newWeights = decodeWeights(newMesh, poses[0].matrices.length);
  const longest = Math.max(slice.width, slice.height);
  const tolerancePx = Math.max(1, longest * .006);
  const { errors, flipped } = deviations(samples(slice, Math.max(1, Math.round(longest / 145))),
    before, oldWeights, after, newWeights, slice, poses);
  const maximumDeviationPx = errors.reduce((a, b) => Math.max(a, b), 0);
  if (flipped.size || maximumDeviationPx > tolerancePx) {
    throw new Error('工程回读形变超限，最大偏差 ' + maximumDeviationPx.toFixed(3) + ' px，翻折 ' + flipped.size + ' 个三角形。');
  }
  return { samples: poses.length, animations: new Set(poses.map(p => p.animation).filter(name => name !== null)).size,
    tolerancePx, maximumDeviationPx, flippedTriangles: flipped.size };
}
