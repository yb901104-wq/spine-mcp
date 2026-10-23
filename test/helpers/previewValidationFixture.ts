import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCanvas } from '@napi-rs/canvas';

/** 一根骨骼、一个 region、一个完整皮肤；不依赖真实角色或拆分换装资源。 */
export async function withPreviewValidationFixture(
  fn: (context: { workspaceRoot: string }, args: { filePath: string; atlasPath: string; skin: string }) => Promise<void>,
  animations: Record<string, unknown> = { neutral: {} },
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spine-validation-'));
  try {
    await writeFile(path.join(root, 'body.json'), JSON.stringify({ skeleton: { spine: '4.1.24' },
      bones: [{ name: 'root' }], slots: [{ name: 'body', bone: 'root', attachment: 'tile' }],
      skins: [{ name: 'default', attachments: { body: { tile: { type: 'region', path: 'tile', width: 16, height: 16 } } } }], animations }));
    await writeFile(path.join(root, 'body.atlas'), 'body.png\nsize: 16,16\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\ntile\n  rotate: false\n  xy: 0,0\n  size: 16,16\n  orig: 16,16\n  offset: 0,0\n  index: -1\n');
    const canvas = createCanvas(16, 16), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#49b6d4'; ctx.fillRect(0, 0, 16, 16);
    await writeFile(path.join(root, 'body.png'), canvas.toBuffer('image/png'));
    await fn({ workspaceRoot: root }, { filePath: 'body.json', atlasPath: 'body.atlas', skin: 'default' });
  } finally { await rm(root, { recursive: true, force: true }); }
}
