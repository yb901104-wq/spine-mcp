import { referenceRoles } from '../../src/referencePose.js';

// 测试用 v2 参考块：默认全部 unknown，只有显式传入的点/证据才参与指标。
export const silhouetteBlock = (over: any = {}) => ({
  version: 1,
  basis: '测试：肩线/髋线同一高度的可见外缘。',
  shoulder: { left: { visibility: 'unknown' }, right: { visibility: 'unknown' } },
  hip: { left: { visibility: 'unknown' }, right: { visibility: 'unknown' } },
  ...over,
});
export const orientationBlock = (over: any = {}) => ({
  version: 1,
  band: 'threeQuarter',
  amplitude: 0.5,
  basis: '测试用相对幅度，只作同序列比较，不是绝对角度。',
  ...over,
});
export const depthBlock = (over: any = {}) => ({
  version: 1,
  basis: '测试用遮挡证据，不代表真实美术判断。',
  evidence: [{ id: 'armsLR', a: 'leftArm', b: 'rightArm', relation: 'front', kind: 'occlusion', basis: '合成夹具：左臂覆盖右臂' }],
  ...over,
});

export function withV2(o: any, over: any = {}) {
  return {
    ...o,
    points: { ...Object.fromEntries(referenceRoles.map(k => [k, { visibility: 'unknown' }])), ...(o.points ?? {}) },
    silhouette: over.silhouette ?? silhouetteBlock(),
    orientation: over.orientation ?? orientationBlock(),
    depth: over.depth ?? depthBlock(),
  };
}
