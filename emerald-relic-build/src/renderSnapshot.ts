import { type Skeleton } from '@esotericsoftware/spine-core';
import { applyPosePresentation } from './posePresentation.js';
import { HostError } from './hostContracts.js';
export const REPLAY_SCHEMA_VERSION = 1;
export interface BoneDelta { rotate?: number; translate?: { x: number; y: number }; scale?: { x:number; y:number } }
export interface RenderSnapshot {
  bones: Record<string, BoneDelta>; skin?: string;
  slotAttachments?: Record<string, string | null>;
  presentation?: { attachments?: Record<string, string | null>; drawOrder?: string[] };
  /** 仅由 Host 从当前校准生成；不从 MCP 派生结果或浏览器参数接收。 */
  scaleLimits?:Record<string,{x:[number,number];y:[number,number]}>;
}
export function applySolution(skeleton: Skeleton, bones: Record<string, BoneDelta>,scaleLimits?:RenderSnapshot['scaleLimits']) {
  for (const [name, value] of Object.entries(bones)) {
    const bone = skeleton.findBone(name);
    if (!bone || !value || typeof value !== 'object' || Object.keys(value).some(k => !['rotate', 'translate','scale'].includes(k))) throw new HostError('SOLUTION_INVALID', `回放骨骼或增量字段无效：${name}`);
    if(value.scale!==undefined){
      if(!value.scale||Object.keys(value.scale).some(k=>!['x','y'].includes(k))||!(['x','y']as const).every(key=>{const n=value.scale![key],range=scaleLimits?.[name]?.[key]??[Number.MIN_VALUE,1];return range.length===2&&range.every(v=>Number.isFinite(v)&&v>0)&&range[0]<=range[1]&&Number.isFinite(n)&&n>0&&n>=range[0]&&n<=range[1];}))throw new HostError('SOLUTION_INVALID','scale 必须是正数且位于当前 Host 校准回放范围；未校准仍不大于 1。');
      bone.scaleX=bone.data.scaleX*value.scale.x;bone.scaleY=bone.data.scaleY*value.scale.y;
    }
    if (value.rotate !== undefined) {
      if (!Number.isFinite(value.rotate)) throw new HostError('SOLUTION_INVALID', 'rotate 必须为有限数。');
      bone.rotation = bone.data.rotation + value.rotate;
    }
    if (value.translate !== undefined) {
      if (!value.translate || Object.keys(value.translate).some(k => !['x', 'y'].includes(k)) || ![value.translate.x, value.translate.y].every(Number.isFinite)) throw new HostError('SOLUTION_INVALID', 'translate 必须含有限 x/y。');
      bone.x = bone.data.x + value.translate.x; bone.y = bone.data.y + value.translate.y;
    }
  }
}
export function applyRenderSnapshot(skeleton: Skeleton, snapshot: RenderSnapshot) {
  if (!snapshot || !snapshot.bones || typeof snapshot.bones !== 'object' || Array.isArray(snapshot.bones)) throw new HostError('SOLUTION_INVALID', '回放缺少 bones。');
  // 每次重置皮肤，防上次 frame 的附件与隐藏状态串入下一次回放。
  if (snapshot.skin && !skeleton.data.findSkin(snapshot.skin)) throw new HostError('DOC_INCOMPLETE', '指定皮肤不存在。');
  skeleton.skin = snapshot.skin ? skeleton.data.findSkin(snapshot.skin) : skeleton.data.defaultSkin;
  skeleton.updateCache();
  skeleton.setToSetupPose();
  applyPosePresentation(skeleton, { attachments: snapshot.slotAttachments });
  applyPosePresentation(skeleton, snapshot.presentation);
  applySolution(skeleton, snapshot.bones,snapshot.scaleLimits);
  skeleton.updateWorldTransform();
  return skeleton;
}
