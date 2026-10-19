import { readFile } from "node:fs/promises";
import { AtlasAttachmentLoader, TextureAtlas, Texture, SkeletonJson, Skeleton, MixBlend, MixDirection, VertexAttachment, RegionAttachment } from "@esotericsoftware/spine-core";
import { resolveWorkspacePath, type ToolContext } from "./spineJson.js";

class RuntimeTexture extends Texture {
  setFilters() {} setWraps() {} dispose() {}
}
export async function loadMotionRuntime(json: any, atlasPath: string, context: ToolContext = {}) {
  const atlas = new TextureAtlas(await readFile(resolveWorkspacePath(atlasPath, context), "utf8"));
  for (const page of atlas.pages) page.setTexture(new RuntimeTexture({ width: page.width, height: page.height } as any));
  const data = new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(json);
  const skeleton = new Skeleton(data);
  return {
    data, skeleton, atlas,
    sample(animation: string | undefined, time: number, skin?: string) {
      if (skin) skeleton.setSkinByName(skin);
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
