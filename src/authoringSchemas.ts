const str = { type: 'string', minLength: 1 };
const number = { type: 'number' };
const time = { ...number, minimum: 0 };
const int = { type: 'integer', minimum: 0 };
const bool = { type: 'boolean' };
const values = (list: string[]) => ({ type: 'string', enum: list });
const object = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', additionalProperties: false, properties, required });
const array = (items: unknown, minItems: number, maxItems: number) => ({ type: 'array', items, minItems, maxItems });
const pairs = { x: number, y: number };
const transform = { ...pairs, rotation: number, scaleX: number, scaleY: number, shearX: number, shearY: number };
const size = { type: 'number', exclusiveMinimum: 0 };
const track = object({ kind: values(['bone', 'slot', 'drawOrder']), name: str, timeline: values(['rotate', 'translate', 'scale', 'shear', 'attachment']) }, ['kind']);
const inspectTrack = object({ kind: values(['bone', 'slot', 'drawOrder']), name: str, timeline: str }, ['kind']);
const frame = object({
  time, value: number, ...pairs, name: { type: ['string', 'null'] },
  curve: { oneOf: [{ const: 'stepped' }, array(number, 4, 8)] },
  offsets: array(object({ slot: str, offset: { type: 'integer' } }, ['slot', 'offset']), 0, 4096),
}, ['time']);
const op = (name: string, fields: Record<string, unknown>, required: string[]) =>
  object({ op: { const: name }, ...fields }, ['op', ...required]);
const range = { track, start: time, end: time };
const ops = [
  op('setFrames', { track, frames: array(frame, 1, 4096) }, ['track', 'frames']),
  op('deleteFrames', range, ['track', 'start', 'end']),
  op('copyFrames', { ...range, toStart: time }, ['track', 'start', 'end', 'toStart']),
  op('retimeFrames', { ...range, toStart: time, toEnd: time }, ['track', 'start', 'end', 'toStart', 'toEnd']),
  op('addBone', { bone: object({ name: str, parent: str, ...transform, length: time,
    transform: values(['normal', 'onlyTranslation', 'noRotationOrReflection', 'noScale', 'noScaleOrReflection']) }, ['name', 'parent']) }, ['bone']),
  op('addSlot', { slot: object({ name: str, bone: str, color: { type: 'string', pattern: '^[0-9a-fA-F]{8}$' },
    blend: values(['normal', 'additive', 'multiply', 'screen']) }, ['name', 'bone']) }, ['slot']),
  op('addAttachment', {
    name: str, skin: str, slot: str, region: str, imagePath: str,
    crop: object({ left: int, top: int, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } }, ['left', 'top', 'width', 'height']),
    attachment: { oneOf: [
      object({ type: { const: 'region' }, ...pairs, rotation: number, scaleX: number, scaleY: number, width: size, height: size }, ['type']),
      object({ type: { const: 'mesh' }, width: size, height: size, uvs: array(number, 6, 16384), vertices: array(number, 6, 131072),
        triangles: array(int, 3, 65536), hull: int, edges: array(int, 0, 65536) }, ['type', 'uvs', 'vertices', 'triangles', 'hull']),
    ] },
  }, ['name', 'skin', 'slot', 'region', 'imagePath', 'attachment']),
];
const dryRun = { ...bool, default: true, description: '默认只预演。false 执行所声明的操作。' };
const project = { filePath: str, atlasPath: str, skeleton: str };
const draft = { draftId: str, expectedRevision: int };
const window = { start: time, end: time };
const page = { offset: int, limit: { type: 'integer', minimum: 1, maximum: 32 } };
const define = (name: string, description: string, properties: Record<string, unknown>, required: string[]) =>
  ({ name, description, inputSchema: object(properties, required) });

export const authoringDefinitions = [
  define('spine_read_reference_frames', '按帧号或秒数查询参考图片原帧、帧延迟与联系表。', {
    filePath: str, startFrame: int, endFrame: int, ...window, ...page, view: values(['sheet', 'frames', 'metadata']),
  }, ['filePath']),
  define('spine_inspect_project', '只读查询工作区内 .spine 或 JSON 的骨架、对象、动画轨道或指定时间的 runtime 画面。', {
    ...project, view: values(['summary', 'bones', 'slots', 'skins', 'attachments', 'constraints', 'timeline', 'frame', 'gif']),
    name: str, animation: str, track: inspectTrack, ...window, ...page, time, skin: str, fps: { ...int, minimum: 1, maximum: 120 },
  }, ['filePath']),
  define('spine_open_animation_draft', '创建独立动画草稿，或从已有动画建立编辑草稿。返回草稿标识、修订与候选哈希。', {
    ...project, animation: str, mode: values(['create', 'edit']),
  }, ['filePath', 'animation', 'mode']),
  define('spine_edit_animation_draft', '对指定修订执行批量关键帧、区间、骨骼、插槽、贴图和附件操作，或执行撤销与重做。', {
    ...draft, ops: array({ oneOf: ops }, 1, 512), history: values(['undo', 'redo']), dryRun,
  }, ['draftId', 'expectedRevision']),
  define('spine_preview_animation_draft', '按草稿修订读取实际 runtime 的帧、GIF、联系表、调试叠加或同步对比。', {
    draftId: str, revision: int, view: values(['state', 'frame', 'gif', 'sheet', 'debug', 'comparison', 'measure']),
    time, skin: str, fps: { ...int, minimum: 1, maximum: 120 }, compareRevision: int, referencePath: str, referenceManifestPath: str,
    phaseMap: array(object({ targetTime: time, referenceTime: time }, ['targetTime', 'referenceTime']), 2, 128),
    measurements: array(object({ bone: str, ...window, tolerance: time }, ['bone', 'start', 'end']), 1, 16),
  }, ['draftId']),
  define('spine_publish_animation_draft', '把匹配修订及哈希的草稿保存为工作区内新的可编辑 Spine 工程目录，或导出 JSON 与运行时贴图。', {
    ...draft, candidateHash: { type: 'string', pattern: '^[0-9a-f]{64}$' }, outputPath: str, format: values(['spine', 'json']), dryRun,
  }, ['draftId', 'expectedRevision', 'candidateHash', 'outputPath']),
];
