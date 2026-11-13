import { validateSpineJson } from './spineJson.js';
import { HostError } from './hostContracts.js';

type Data = Record<string, any>;
export type Track = { kind: 'bone' | 'slot' | 'drawOrder'; name?: string; timeline?: string };
export type DraftAsset = { region: string; source: string; sourceHash: string; hash: string; width: number; height: number };

export function invalid(message: string): never {
  throw new HostError('INVALID_ARGUMENT', message, 400);
}
export function authoringName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f]/.test(value) ||
      ['__proto__', 'prototype', 'constructor'].includes(value)) invalid(`${label}名称无效。`);
  return value;
}
const timeOf = (frame: Data) => frame.time ?? 0;
const timeKey = (time: number) => {
  if (!Number.isFinite(time) || time < 0) invalid('关键帧时间必须是有限的非负秒数。');
  return Math.round(time * 1e6) / 1e6;
};
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function animationDuration(animation: unknown): number {
  if (!animation || typeof animation !== 'object') return 0;
  if (Array.isArray(animation)) return animation.reduce((end, value) => Math.max(end, animationDuration(value)), 0);
  const value = animation as Data;
  return Object.values(value).reduce<number>((end, child) => Math.max(end, animationDuration(child)), typeof value.time === 'number' ? value.time : 0);
}

function framesFor(json: Data, animation: Data, track: Track, create = false): Data[] {
  if (track.kind === 'drawOrder') {
    if (track.name !== undefined || track.timeline !== undefined) invalid('drawOrder 轨道无需名称和 timeline。');
    const key = Object.hasOwn(animation, 'draworder') ? 'draworder' : 'drawOrder';
    return create ? animation[key] ??= [] : animation[key] ?? [];
  }
  const kind = track.kind === 'bone' ? 'bones' : 'slots';
  const name = authoringName(track.name, '轨道对象');
  const timeline = authoringName(track.timeline, 'timeline');
  const supported = track.kind === 'bone' ? ['rotate', 'translate', 'scale', 'shear'] : ['attachment'];
  if (!supported.includes(timeline)) invalid(`当前操作不支持 ${kind}/${name}/${timeline}。`);
  if (!json[kind]?.some((entry: Data) => entry.name === name)) invalid(`找不到轨道对象 ${kind}/${name}。`);
  if (create) {
    const tracks = animation[kind] ??= {};
    const object = Object.hasOwn(tracks, name) ? tracks[name] : (tracks[name] = {});
    return object[timeline] ??= [];
  }
  const tracks = animation[kind];
  return tracks && Object.hasOwn(tracks, name) ? tracks[name][timeline] ?? [] : [];
}

function setFrames(json: Data, animation: Data, op: Data) {
  const frames = framesFor(json, animation, op.track, true);
  const seen = new Set<number>();
  for (const value of op.frames) {
    const time = timeKey(value.time);
    if (seen.has(time)) invalid(`批次轨道含重复关键帧 ${time}s。`);
    seen.add(time);
    const frame = { ...value, time };
    if (op.track.timeline === 'attachment' && !Object.hasOwn(frame, 'name')) invalid('附件关键帧必须指定名称或 null。');
    if (op.track.timeline === 'attachment' && frame.name === null) delete frame.name;
    if (op.track.timeline === 'attachment' && frame.name === null) delete frame.name;
    const index = frames.findIndex(old => timeKey(timeOf(old)) === time);
    if (index === -1) frames.push(frame);
    else frames[index] = frame;
  }
  frames.sort((a, b) => timeOf(a) - timeOf(b));
}

function rangeEdit(json: Data, animation: Data, op: Data) {
  const start = timeKey(op.start), end = timeKey(op.end);
  if (end < start) invalid('区间结束时间早于起始时间。');
  const frames = framesFor(json, animation, op.track);
  const inside = frames.filter(frame => timeOf(frame) >= start && timeOf(frame) <= end);
  if (!inside.length) return;
  const outside = frames.filter(frame => !inside.includes(frame));
  if (op.op === 'deleteFrames') {
    if (outside.at(-1)?.curve !== undefined) invalid('删除会使区间外的关键帧成为带 curve 的末帧，请先显式更新该曲线。');
    frames.splice(0, frames.length, ...outside);
    return;
  }
  const newStart = timeKey(op.toStart), newEnd = op.op === 'copyFrames' ? newStart + end - start : timeKey(op.toEnd);
  if (newEnd < newStart || (end > start && newEnd === newStart)) invalid('目标区间必须保留时间顺序。');
  const factor = end === start ? 1 : (newEnd - newStart) / (end - start);
  const map = (time: number) => timeKey(newStart + (time - start) * factor);
  const retained = op.op === 'copyFrames' ? frames : outside;
  const occupied = new Set(retained.map(frame => timeKey(timeOf(frame))));
  const label = [op.track.kind, op.track.name, op.track.timeline].filter(Boolean).join('/');
  const moved = inside.map(original => {
    const frame = structuredClone(original);
    frame.time = map(timeOf(frame));
    if (occupied.has(frame.time)) throw new HostError('KEYFRAME_CONFLICT', `轨道 ${label} 在 ${frame.time}s 已有关键帧。`, 409);
    occupied.add(frame.time);
    if (Array.isArray(frame.curve)) frame.curve = frame.curve.map((value: number, i: number) => i % 2 === 0 ? map(value) : value);
    return frame;
  });
  const next = [...retained, ...moved].sort((a, b) => timeOf(a) - timeOf(b));
  // 移动后控制点仍需落在其所属插值段内，避免把原有曲线隐式套到不同的下一帧。
  for (const [i, frame] of next.entries()) {
    if (!Array.isArray(frame.curve)) continue;
    if (!next[i + 1] || frame.curve.some((value: number, k: number) => k % 2 === 0 && (value < timeOf(frame) || value > timeOf(next[i + 1])))) {
      invalid(`轨道 ${label} 的 ${timeOf(frame)}s 曲线超出调整后的区间，请显式重设曲线。`);
    }
  }
  frames.splice(0, frames.length, ...next);
}

function addBones(json: Data, operations: Data[]) {
  const pending = [...operations];
  while (pending.length) {
    const index = pending.findIndex(({ bone }) => json.bones.some((entry: Data) => entry.name === bone.parent));
    if (index < 0) invalid(`骨骼父引用缺失或成环：${pending.map(({ bone }) => `${bone.name} → ${bone.parent}`).join('、')}。`);
    const [{ bone }] = pending.splice(index, 1);
    const name = authoringName(bone.name, '骨骼');
    if (json.bones.some((entry: Data) => entry.name === name)) invalid(`骨骼已存在：${name}。`);
    json.bones.push(structuredClone(bone));
  }
}

function addSlot(json: Data, slot: Data) {
  const name = authoringName(slot.name, '插槽');
  json.slots ??= [];
  if (json.slots.some((entry: Data) => entry.name === name)) invalid(`插槽已存在：${name}。`);
  if (!json.bones.some((entry: Data) => entry.name === slot.bone)) invalid(`插槽 ${name} 的骨骼不存在：${slot.bone}。`);
  json.slots.push(structuredClone(slot));
}

function validateMesh(mesh: Data, boneCount: number) {
  const count = mesh.uvs.length / 2;
  if (!Number.isInteger(count) || count < 3 || mesh.uvs.some((value: number) => value < 0 || value > 1) ||
      mesh.triangles.length % 3 || mesh.triangles.some((value: number) => value < 0 || value >= count) ||
      (mesh.hull !== undefined && (mesh.hull < 0 || mesh.hull > count))) invalid('网格 UV、三角形或 hull 无效。');
  if (mesh.vertices.length === 2 * count) return;
  let offset = 0;
  for (let vertex = 0; vertex < count; vertex++) {
    const influences = mesh.vertices[offset++];
    if (!Number.isInteger(influences) || influences < 1 || offset + 4 * influences > mesh.vertices.length) invalid(`网格顶点 ${vertex} 的权重记录长度无效。`);
    let sum = 0;
    const seen = new Set<number>();
    for (let n = 0; n < influences; n++) {
      const [bone, x, y, weight] = mesh.vertices.slice(offset, offset + 4);
      if (!Number.isInteger(bone) || bone < 0 || bone >= boneCount || seen.has(bone) || !Number.isFinite(x) ||
          !Number.isFinite(y) || !Number.isFinite(weight) || weight < 0 || weight > 1) invalid(`网格顶点 ${vertex} 的骨骼引用或权重无效。`);
      sum += weight;
      seen.add(bone);
      offset += 4;
    }
    if (Math.abs(sum - 1) > 0.001) invalid(`网格顶点 ${vertex} 的权重之和必须为 1。`);
  }
  if (offset !== mesh.vertices.length) invalid('网格权重含多余数据。');
}

function attachmentEntries(json: Data, op: Data, create: boolean): Data | undefined {
  const skinName = authoringName(op.skin, '皮肤');
  const target = json.slots?.find((slot: Data) => slot.name === op.slot);
  if (!target) invalid(`附件的插槽不存在：${op.slot}。`);
  const skins = json.skins ??= [];
  let skin = skins.find((entry: Data) => entry.name === skinName);
  if (!skin && create) {
    skin = { name: skinName, attachments: {} };
    skins.push(skin);
  }
  if (!skin) return undefined;
  const slot = authoringName(op.slot, '插槽');
  if (!create) return skin.attachments?.[slot];
  const slots = skin.attachments ??= {};
  return Object.hasOwn(slots, slot) ? slots[slot] : (slots[slot] = {});
}

function writeAttachment(json: Data, animationName: string, op: Data, asset: DraftAsset) {
  const name = authoringName(op.name, '附件');
  const replace = op.op === 'replaceAttachment';
  const attachments = attachmentEntries(json, op, !replace);
  const previous = attachments && Object.hasOwn(attachments, name) ? attachments[name] : undefined;
  const target = json.slots.find((slot: Data) => slot.name === op.slot);
  if (!replace && (target.attachment === name || Object.entries(json.animations).some(([animation, value]) => animation !== animationName &&
      (value as Data).slots?.[op.slot]?.attachment?.some((frame: Data) => frame.name === name)))) {
    invalid(`附件 ${op.slot}/${name} 会影响已有 setup 或未选中的动画，请使用新的附件名称。`);
  }
  if (replace) {
    if (!previous) invalid(`找不到待替换附件：${op.skin}/${op.slot}/${name}。`);
    if (!['mesh', 'region'].includes(previous.type ?? 'region') || previous.sequence) {
      invalid(`附件 ${op.slot}/${name} 的类型或序列需要单独迁移。`);
    }
    const hasDeform = (Object.values(json.animations) as Data[]).some(animation =>
      animation.attachments?.[op.skin]?.[op.slot]?.[name]?.deform !== undefined ||
      animation.deform?.[op.skin]?.[op.slot]?.[name] !== undefined);
    const hasLinkedMesh = (json.skins ?? []).some((skin: Data) =>
      (Object.values(skin.attachments?.[op.slot] ?? {}) as Data[]).some(entry =>
        entry.type === 'linkedmesh' && entry.parent === name && (entry.skin ?? skin.name) === op.skin));
    if (hasDeform || hasLinkedMesh) invalid(`附件 ${op.slot}/${name} 有 deform 或链接网格引用，需要先保留其拓扑并迁移引用。`);
  } else if (previous) {
    invalid(`附件已存在：${op.skin}/${op.slot}/${name}。`);
  }
  const inherited = previous ? { ...(previous.color ? { color: previous.color } : {}), ...(previous.name ? { name: previous.name } : {}) } : {};
  const attachment: Data = { ...inherited, ...op.attachment, width: asset.width, height: asset.height, path: asset.region };
  if (attachment.type === 'mesh') {
    validateMesh(attachment, json.bones.length);
  } else {
    // 编辑器从实际切片读取尺寸。把所需显示尺寸表达成缩放，往返时保留相同轮廓。
    attachment.scaleX = (op.attachment.scaleX ?? 1) * (op.attachment.width ?? asset.width) / asset.width;
    attachment.scaleY = (op.attachment.scaleY ?? 1) * (op.attachment.height ?? asset.height) / asset.height;
  }
  attachments![name] = attachment;
}

export async function editCandidate(base: Data, animationName: string, operations: Data[], loadAsset: (op: Data) => Promise<DraftAsset>) {
  const json = structuredClone(base);
  const animation = json.animations[animationName] as Data;
  addBones(json, operations.filter(op => op.op === 'addBone'));
  for (const op of operations.filter(op => op.op === 'addSlot')) addSlot(json, op.slot);
  const assets: DraftAsset[] = [];
  const replacements = new Set<string>();
  for (const op of operations.filter(op => op.op === 'addAttachment' || op.op === 'replaceAttachment')) {
    if (op.op === 'replaceAttachment') {
      const key = JSON.stringify([op.skin, op.slot, op.name]);
      if (replacements.has(key)) invalid(`批次重复替换附件：${op.skin}/${op.slot}/${op.name}。`);
      replacements.add(key);
    }
    const asset = await loadAsset(op);
    writeAttachment(json, animationName, op, asset);
    assets.push(asset);
  }
  for (const op of operations) {
    if (op.op === 'setFrames') setFrames(json, animation, op);
    if (['deleteFrames', 'copyFrames', 'retimeFrames'].includes(op.op)) rangeEdit(json, animation, op);
  }
  const audit = validateSpineJson(json);
  if (!audit.ok) throw new HostError('VALIDATION_FAILED', '动画草稿未通过 Spine 结构或关键帧校验。', 400, audit.issues);
  // 仅允许追加结构及显式替换目标附件；已有轨道与其他附件逐项比较。
  for (const key of Object.keys(base)) {
    if (!['bones', 'slots', 'skins', 'animations'].includes(key) && !equal(json[key], base[key])) invalid(`补丁超出范围：${key}。`);
  }
  for (const key of ['bones', 'slots']) {
    if (!equal(json[key]?.slice(0, base[key]?.length ?? 0) ?? [], base[key] ?? [])) invalid(`补丁改动了已有 ${key}。`);
  }
  for (const [name, old] of Object.entries(base.animations)) {
    if (name !== animationName && !equal(json.animations[name], old)) invalid(`补丁改动了未选中的动画 ${name}。`);
  }
  for (const old of base.skins ?? []) {
    const next = json.skins.find((skin: Data) => skin.name === old.name);
    for (const [slot, entries] of Object.entries(old.attachments ?? {})) {
      for (const [name, value] of Object.entries(entries as Data)) {
        if (!replacements.has(JSON.stringify([old.name, slot, name])) && !equal(next?.attachments?.[slot]?.[name], value)) {
          invalid(`补丁改动了已有附件 ${old.name}/${slot}/${name}。`);
        }
      }
    }
  }
  return { json, assets, replacedAttachments: replacements.size };
}
