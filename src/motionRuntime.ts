import { readFile } from "node:fs/promises";
import { AtlasAttachmentLoader, TextureAtlas, Texture, SkeletonJson, Skeleton, MixBlend, MixDirection, VertexAttachment, RegionAttachment } from "@esotericsoftware/spine-core";
import { resolveWorkspacePath, type ToolContext } from "./spineJson.js";
import { cachedRuntime,cacheHash } from './runtimeCache.js';

class RuntimeTexture extends Texture {
  setFilters() {} setWraps() {} dispose() {}
}
export async function loadMotionRuntime(json: any, atlasPath: string, context: ToolContext = {}) {
  return createMotionRuntime(json, await readFile(resolveWorkspacePath(atlasPath, context), "utf8"));
}
/** 从已核实的内存资源加载；每次创建独立可变 Skeleton。 */
export function createMotionRuntime(json: any, atlasRaw: string) {
  const raw=JSON.stringify(json),key=cacheHash(raw+'\0'+atlasRaw);
  const {atlas,data}=cachedRuntime(key,()=>{
    const atlas=new TextureAtlas(atlasRaw);
    for(const page of atlas.pages)page.setTexture(new RuntimeTexture({width:page.width,height:page.height}as any));
    return{atlas,data:new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(json)};
  },Buffer.byteLength(raw)*12+Buffer.byteLength(atlasRaw)*8);
  return forkMotionRuntime({data,atlas});
}
/** 从已准备的不可变模板分出私有运行态；不读文件。 */
export function forkMotionRuntime({data,atlas}:{data:ReturnType<SkeletonJson['readSkeletonData']>;atlas:TextureAtlas}){
  const skeleton = new Skeleton(data);
  return {
    data, skeleton, atlas,
    sample(animation: string | undefined, time: number, skin?: string) {
      if(skin&&!data.findSkin(skin))throw new Error(`runtime 找不到皮肤 ${skin}。`);
      skeleton.skin=skin?data.findSkin(skin):data.defaultSkin;skeleton.updateCache();
      skeleton.setToSetupPose();
      if (animation) {
        const a = data.findAnimation(animation);
        if (!a) throw new Error(`runtime 找不到动画 ${animation}。`);
        a.apply(skeleton, 0, time, false, [], 1, MixBlend.replace, MixDirection.mixIn);
      }
      skeleton.updateWorldTransform();
      return skeleton;
    },
  };
}

export function worldVertices(skeleton: Skeleton) {
  const result: Record<string, number[]> = {};
  for (const slot of skeleton.slots) {
    const attachment = slot.getAttachment();
    if (attachment instanceof VertexAttachment) {
      const vertices = new Array<number>(attachment.worldVerticesLength).fill(0);
      attachment.computeWorldVertices(slot, 0, vertices.length, vertices, 0, 2);
      result[slot.data.name + ":" + attachment.name] = vertices;
    } else if (attachment instanceof RegionAttachment) {
      const vertices = new Array<number>(8).fill(0);
      attachment.computeWorldVertices(slot, vertices, 0, 2);
      result[slot.data.name + ":" + attachment.name] = vertices;
    }
  }
  return result;
}
