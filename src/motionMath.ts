/** Spine 4.1 的曲线控制点使用绝对时间和数值。 */
export type Frame = Record<string, any>;
export type Point = [number, number];
export const wrapAngle = (v: number) => ((v + 180) % 360 + 360) % 360 - 180;
export function sampleTimeline(frames: Frame[] | undefined, t: number, key: string, fallback = 0): number {
  if (!frames?.length || t < (frames[0].time ?? 0)) return fallback;
  let low = 0, high = frames.length;
  while (low < high) { const mid = (low + high) >>> 1; if ((frames[mid].time ?? 0) <= t) low = mid + 1; else high = mid; }
  for (let i = Math.max(0, low - 1); i < frames.length - 1; i++) {
    const f = frames[i], g = frames[i + 1], a = f.time ?? 0, b = g.time ?? 0;
    if (t >= b) continue;
    const v = f[key] ?? fallback, w = g[key] ?? fallback;
    if (f.curve === "stepped") return v;
    if (Array.isArray(f.curve)) {
      const offset = key === "y" && f.curve.length >= 8 ? 4 : 0;
      const [x1, y1, x2, y2] = f.curve.slice(offset, offset + 4);
      let lo = 0, hi = 1;
      for (let j = 0; j < 40; j++) {
        const z = (lo + hi) / 2;
        if (cubic(a, x1, x2, b, z) < t) lo = z; else hi = z;
      }
      return cubic(v, y1, y2, w, (lo + hi) / 2);
    }
    return v + (w - v) * (t - a) / (b - a);
  }
  return frames.at(-1)![key] ?? fallback;
}
function cubic(a: number, b: number, c: number, d: number, u: number) {
  const v = 1 - u; return v ** 3 * a + 3 * v * v * u * b + 3 * v * u * u * c + u ** 3 * d;
}

export function solveTwoBoneIK(hip: Point, target: Point, l1: number, l2: number, bend: 1 | -1) {
  if (![...hip, ...target, l1, l2].every(Number.isFinite) || l1 <= 0 || l2 <= 0) throw new Error("IK 输入或骨骼长度无效。");
  const dx = target[0] - hip[0], dy = target[1] - hip[1], distance = Math.hypot(dx, dy);
  const min = Math.abs(l1 - l2), max = l1 + l2;
  const reachable = distance >= min - 1e-8 && distance <= max + 1e-8;
  const d = Math.max(min + 1e-10, Math.min(max - 1e-10, distance));
  const phi = distance > 1e-12 ? Math.atan2(dy, dx) : -Math.PI / 2;
  const theta = Math.acos(Math.max(-1, Math.min(1, (d * d + l1 * l1 - l2 * l2) / (2 * d * l1))));
  const thigh = phi + bend * theta;
  const knee: Point = [hip[0] + l1 * Math.cos(thigh), hip[1] + l1 * Math.sin(thigh)];
  const endpoint: Point = [hip[0] + d * Math.cos(phi), hip[1] + d * Math.sin(phi)];
  const shin = Math.atan2(endpoint[1] - knee[1], endpoint[0] - knee[0]);
  return { upperAngle: thigh * 180 / Math.PI, lowerAngle: shin * 180 / Math.PI, knee, endpoint, reachable, error: Math.abs(d - distance) };
}
export const solveArmIK = solveTwoBoneIK;
export function lockFootContact(target: Point, anchor: Point, angle: number): Point {
  const r = angle * Math.PI / 180;
  return [target[0] - anchor[0] * Math.cos(r) + anchor[1] * Math.sin(r), target[1] - anchor[0] * Math.sin(r) - anchor[1] * Math.cos(r)];
}

export function fitCubicBezierTimeline(frames: Frame[], keys: string[], tolerance: number, subdivisions = 8, defaults = 0, maxSegmentDelta = Infinity) {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("曲线容差必须是非负有限数。");
  if (!Number.isInteger(subdivisions) || subdivisions < 2 || subdivisions > 64) throw new Error("曲线采样密度必须为 2 到 64。");
  if (!frames.length) return { frames: [], originalCount: 0, compressedCount: 0, maxError: 0 };
  // 离散切换必须原样保留，不能用连续曲线跨越。
  if (frames.some(f => f.curve === "stepped")) return { frames: structuredClone(frames), originalCount: frames.length, compressedCount: frames.length, maxError: 0 };
  const points: Frame[] = [];
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i].time ?? 0, b = frames[i + 1].time ?? 0;
    if (b <= a) throw new Error("曲线时间必须严格递增。");
    for (let j = 0; j < subdivisions; j++) {
      const time = a + (b - a) * j / subdivisions;
      points.push({ time, ...Object.fromEntries(keys.map(k => [k, sampleTimeline(frames, time, k, defaults)])) });
    }
  }
  points.push({ time: frames.at(-1)!.time ?? 0, ...Object.fromEntries(keys.map(k => [k, frames.at(-1)![k] ?? defaults])) });
  const ys = (i: number, k: string) => points[i][k];
  const result: Frame[] = [];
  function split(i: number, j: number) {
    const a = points[i].time, b = points[j].time, dt = b - a;
    if (j === i || dt === 0) return;
    let aa = 0, ab = 0, bb = 0;
    const rhs = keys.map(() => [0, 0]);
    for (let n = i; n <= j; n++) {
      const u = (points[n].time - a) / dt, v = 1 - u, x = 3 * v * v * u, y = 3 * v * u * u;
      aa += x * x; ab += x * y; bb += y * y;
      keys.forEach((k, col) => { const residual = ys(n, k) - v ** 3 * ys(i, k) - u ** 3 * ys(j, k); rhs[col][0] += x * residual; rhs[col][1] += y * residual; });
    }
    const det = aa * bb - ab * ab;
    const controls = keys.map((k, col) => Math.abs(det) < 1e-20
      ? [ys(i, k) + (ys(j, k) - ys(i, k)) / 3, ys(i, k) + 2 * (ys(j, k) - ys(i, k)) / 3]
      : [(rhs[col][0] * bb - rhs[col][1] * ab) / det, (rhs[col][1] * aa - rhs[col][0] * ab) / det]);
    let error = 0, worst = i + 1;
    for (let n = i; n <= j; n++) {
      const u = (points[n].time - a) / dt;
      keys.forEach((k, col) => { const e = Math.abs(cubic(ys(i, k), controls[col][0], controls[col][1], ys(j, k), u) - ys(n, k)); if (e > error) { error = e; worst = n; } });
    }
    const largeDelta=keys.some(k=>Math.abs(ys(j,k)-ys(i,k))>maxSegmentDelta);
    if ((error > tolerance * .95 || largeDelta) && j > i + 1) {
      if(largeDelta)worst=Math.floor((i+j)/2);
      worst = Math.max(i + 1, Math.min(j - 1, worst)); split(i, worst); split(worst, j); return;
    }
    const f: Frame = { time: a, ...Object.fromEntries(keys.map(k => [k, ys(i, k)])) };
    f.curve = controls.flatMap(c => [a + dt / 3, c[0], a + 2 * dt / 3, c[1]]);
    result.push(f);
  }
  const constant = keys.every(k => points.every(p => Math.abs(p[k] - points[0][k]) < 1e-12));
  if (constant) result.push({ ...points[0] });
  else { split(0, points.length - 1); result.push({ ...points.at(-1)! }); }
  delete result.at(-1)!.curve;
  let maxError = 0;
  for (let i = 0; i < points.length - 1; i++) for (let j = 0; j <= 2; j++) {
    const t = points[i].time + (points[i + 1].time - points[i].time) * j / 2;
    for (const key of keys) maxError = Math.max(maxError, Math.abs(sampleTimeline(frames, t, key, defaults) - sampleTimeline(result, t, key, defaults)));
  }
  // 验证失败则保留原数据，绝不以压缩比例牺牲容差。
  if (maxError > tolerance + 1e-9) return { frames: structuredClone(frames), originalCount: frames.length, compressedCount: frames.length, maxError: 0 };
  return { frames: result, originalCount: frames.length, compressedCount: result.length, maxError };
}
