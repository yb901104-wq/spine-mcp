import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import {
  agentPing,
  getAgentConnectionStatus,
} from "../src/agentTools.js";
import {
  listBackups,
  restoreBackup,
} from "../src/backupTools.js";
import {
  checkPreviewAssets,
  getPreviewConfig,
  getPreviewUrl,
  runValidationPipeline,
  validatePreviewRuntime,
} from "../src/previewTools.js";
import {
  clearPreviewSession,
  getPreviewSession,
  setPreviewSession,
} from "../src/sessionTools.js";
import {
  applyPoseKeyframes,
  applyPoseSequence,
  cloneAnimation,
  copyKeyframeRange,
  createAnimation,
  deleteAnimation,
  deleteKeyframeRange,
  getAnimationSheet,
  getAnimations,
  getDocumentSummary,
  getOfficialSpecSummary,
  getSkeletonHierarchy,
  getSlots,
  makeLoop,
  offsetBoneTimelineValues,
  readSpineDocument,
  removeKeyframe,
  scaleKeyframeTimes,
  setBoneKeyframe,
  setDrawOrderKeyframe,
  setSlotAttachmentKeyframe,
  shiftKeyframes,
  validateOfficialAnimationSpec,
  validateSpineJson,
} from "../src/spineJson.js";

const workspaceRoot = process.cwd();
const outputDir = path.join(workspaceRoot, "test-output");
const testContext = { backupRoot: path.join(outputDir, "backups") };
const emptyFixture = "example-json/skeleton-Empty-4.1.json";
const contentFixture = "example-json/skeleton-4.1.json";

test.beforeEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
});

test.after(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

test("summarizes blank and content fixtures", async () => {
  const empty = getDocumentSummary(await readSpineDocument(emptyFixture));
  assert.equal(empty.version, "4.1.24");
  assert.equal(empty.counts.bones, 1);
  assert.equal(empty.counts.slots, 0);
  assert.equal(empty.counts.animations, 1);

  const content = getDocumentSummary(await readSpineDocument(contentFixture));
  assert.equal(content.version, "4.1.24");
  assert.equal(content.counts.bones, 93);
  assert.equal(content.counts.slots, 33);
  assert.equal(content.counts.skins, 3);
  assert.ok(content.counts.animations >= 17);
});

test("queries hierarchy, slots, and animations", async () => {
  const document = await readSpineDocument(contentFixture);
  const hierarchy = getSkeletonHierarchy(document, true);
  assert.equal(hierarchy.boneCount, 93);
  assert.equal(hierarchy.roots[0].name, "root");
  assert.ok(hierarchy.roots[0].children.length > 0);

  const slots = getSlots(document);
  assert.equal(slots.slotCount, 33);
  assert.equal(slots.slots[0].name, "xiaoren-22");

  const animations = getAnimations(document);
  const idle = animations.animations.find((animation) => animation.name === "idle");
  assert.ok(idle);
  assert.equal(idle.duration, 1);
  assert.ok(idle.timelineTypes.bones.rotate > 0);
});

test("official spec summary exposes writable timeline rules", async () => {
  const summary = getOfficialSpecSummary();
  assert.equal(summary.supportedVersion, "4.1.24");
  assert.ok(summary.source.includes("spine-json-format"));
  assert.ok(summary.writableTimelineSpecs.some((spec) => spec.timeline === "rotate" && spec.spine4124Fields.includes("value")));
  assert.ok(summary.writableTimelineSpecs.some((spec) => spec.timeline === "attachment"));
});

test("dry-run bone keyframe does not change file hash", async () => {
  const target = await copyFixture(contentFixture, "dry-run.json");
  const before = (await readSpineDocument(target)).hash;
  const result = await setBoneKeyframe(target, {
    animation: "idle",
    bone: "3",
    timeline: "rotate",
    time: 0.25,
    value: 12.5,
    dryRun: true,
    expectedHash: before,
  }, testContext);
  const after = (await readSpineDocument(target)).hash;
  assert.equal(result.dryRun, true);
  assert.equal(after, before);
  assert.equal(result.hashAfter, null);
  assert.equal(result.summary.operation, "spine_set_bone_keyframe");
  assert.equal(result.summary.wroteFile, false);
  assert.equal(result.operationValidation.ok, true);
  assert.equal(result.officialSpecValidation.ok, true);
  assert.ok(result.officialSpecValidation.rulesApplied.includes("bone.rotate"));
  assert.ok(result.operationValidation.allowedPathPatterns.some((pattern) => pattern.includes("\\/animations")));
});

test("committed bone keyframes insert sorted and update same time", async () => {
  const target = await copyFixture(contentFixture, "bone-write.json");
  const before = (await readSpineDocument(target)).hash;
  await setBoneKeyframe(target, {
    animation: "idle",
    bone: "3",
    timeline: "rotate",
    time: 0.25,
    value: 12.5,
    dryRun: false,
    expectedHash: before,
  }, testContext);
  const middle = await readSpineDocument(target);
  await setBoneKeyframe(target, {
    animation: "idle",
    bone: "3",
    timeline: "rotate",
    time: 0.25,
    value: 15,
    dryRun: false,
    expectedHash: middle.hash,
  }, testContext);
  const json = (await readSpineDocument(target)).json;
  const keyframes = json.animations.idle.bones["3"].rotate;
  assert.equal(keyframes.filter((keyframe: any) => keyframe.time === 0.25).length, 1);
  assert.equal(keyframes.find((keyframe: any) => keyframe.time === 0.25).value, 15);
  assert.deepEqual([...keyframes].map((keyframe: any) => keyframe.time ?? 0), [...keyframes].map((keyframe: any) => keyframe.time ?? 0).sort((a, b) => a - b));
});

test("slot attachment keyframe supports visible and hidden attachments", async () => {
  const target = await copyFixture(contentFixture, "slot-write.json");
  let document = await readSpineDocument(target);
  await setSlotAttachmentKeyframe(target, {
    animation: "idle",
    slot: "xiaoren-0",
    time: 0.25,
    attachmentName: "xiaoren-0",
    dryRun: false,
    expectedHash: document.hash,
  }, testContext);
  document = await readSpineDocument(target);
  await setSlotAttachmentKeyframe(target, {
    animation: "idle",
    slot: "xiaoren-0",
    time: 0.5,
    attachmentName: null,
    dryRun: false,
    expectedHash: document.hash,
  }, testContext);
  const attachment = (await readSpineDocument(target)).json.animations.idle.slots["xiaoren-0"].attachment;
  assert.equal(attachment.find((keyframe: any) => keyframe.time === 0.25).name, "xiaoren-0");
  assert.equal("name" in attachment.find((keyframe: any) => keyframe.time === 0.5), false);
});

test("unsupported version and expectedHash reject writes", async () => {
  const target = await copyFixture(contentFixture, "unsupported.json");
  const document = await readSpineDocument(target);
  document.json.skeleton.spine = "4.2.0";
  await writeFile(path.join(workspaceRoot, target), JSON.stringify(document.json), "utf8");

  await assert.rejects(
    () => setBoneKeyframe(target, {
      animation: "idle",
      bone: "3",
      timeline: "rotate",
      time: 0.2,
      value: 1,
      dryRun: true,
    }),
    /Writes support Spine 4\.1\.24/,
  );

  const supported = await copyFixture(contentFixture, "hash-mismatch.json");
  await assert.rejects(
    () => setBoneKeyframe(supported, {
      animation: "idle",
      bone: "3",
      timeline: "rotate",
      time: 0.2,
      value: 1,
      dryRun: true,
      expectedHash: "bad-hash",
    }),
    /expectedHash mismatch/,
  );
});

test("draw order keyframes work on a minimal fixture", async () => {
  const target = "test-output/draw-order.json";
  await writeFile(path.join(workspaceRoot, target), JSON.stringify({
    skeleton: { spine: "4.1.24" },
    bones: [{ name: "root" }],
    slots: [
      { name: "body", bone: "root", attachment: "body" },
      { name: "arm", bone: "root", attachment: "arm" },
    ],
    skins: [{ name: "default", attachments: { body: { body: { width: 10, height: 10 } }, arm: { arm: { width: 10, height: 10 } } } }],
    animations: { idle: {} },
  }), "utf8");

  const result = await setDrawOrderKeyframe(target, {
    animation: "idle",
    time: 0.25,
    offsets: [{ slot: "arm", offset: -1 }],
    dryRun: false,
  }, testContext);
  assert.equal(result.dryRun, false);
  const json = (await readSpineDocument(target)).json;
  assert.deepEqual(json.animations.idle.drawOrder[0], { time: 0.25, offsets: [{ slot: "arm", offset: -1 }] });
});

test("remove keyframe keeps timeline array", async () => {
  const target = await copyFixture(contentFixture, "remove.json");
  let document = await readSpineDocument(target);
  await setBoneKeyframe(target, {
    animation: "idle",
    bone: "3",
    timeline: "rotate",
    time: 0.25,
    value: 12.5,
    dryRun: false,
    expectedHash: document.hash,
  }, testContext);
  document = await readSpineDocument(target);
  await removeKeyframe(target, {
    animation: "idle",
    targetType: "bone",
    targetName: "3",
    timeline: "rotate",
    time: 0.25,
    dryRun: false,
    expectedHash: document.hash,
  }, testContext);
  const keyframes = (await readSpineDocument(target)).json.animations.idle.bones["3"].rotate;
  assert.equal(Array.isArray(keyframes), true);
  assert.equal(keyframes.some((keyframe: any) => keyframe.time === 0.25), false);
});

test("validation catches missing references", async () => {
  const valid = validateSpineJson((await readSpineDocument(contentFixture)).json);
  assert.equal(valid.ok, true);

  const broken = (await readSpineDocument(contentFixture)).json;
  broken.animations.idle.bones.missing_bone = { rotate: [{ time: 0.1, value: 1 }] };
  broken.animations.idle.slots["xiaoren-0"].attachment.push({ time: 2, name: "missing_attachment" });
  const result = validateSpineJson(broken);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path.includes("missing_bone")));
  assert.ok(result.issues.some((issue) => issue.message.includes("missing_attachment")));
});

test("validation catches unsupported timeline fields and wrong value types", async () => {
  const broken = (await readSpineDocument(contentFixture)).json;
  broken.animations.idle.bones["3"].rotate[0].badField = true;
  broken.animations.idle.bones["3"].rotate[0].value = "not-a-number";
  broken.animations.idle.slots["xiaoren-0"].attachment[0].name = 123;
  const result = validateSpineJson(broken);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path.endsWith("/badField")));
  assert.ok(result.issues.some((issue) => issue.path.endsWith("/value")));
  assert.ok(result.issues.some((issue) => issue.path.endsWith("/name")));
});

test("official spec validation catches 4.1.24 rotate field mismatch and accepts multi-axis curves", async () => {
  const valid = (await readSpineDocument(contentFixture)).json;
  const validResult = validateOfficialAnimationSpec(valid);
  assert.equal(validResult.ok, true);
  assert.ok(validResult.checkedTimelineCount > 0);

  const broken = (await readSpineDocument(contentFixture)).json;
  broken.animations.idle.bones["3"].rotate[0].angle = 10;
  const result = validateOfficialAnimationSpec(broken);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path.endsWith("/angle")));
});

test("official spec validation rejects curve on final keyframe", async () => {
  const broken = (await readSpineDocument(contentFixture)).json;
  broken.animations.idle.bones["3"].rotate.push({ time: 1.5, value: -10.13, curve: [0.25, 0, 0.75, 1] });
  const result = validateOfficialAnimationSpec(broken);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path.endsWith("/curve") && issue.message.includes("最后一帧")));
});

test("write tools reject unsupported timeline filters", async () => {
  const target = await copyFixture(contentFixture, "unsupported-timeline-filter.json");
  await assert.rejects(
    () => shiftKeyframes(target, {
      animation: "idle",
      targets: [{ targetType: "slot", names: ["xiaoren-0"], timelines: ["color"] }],
      deltaTime: 0.1,
      dryRun: true,
    }),
    /不支持写入 slot timeline 'color'/,
  );
});

test("create animation succeeds and duplicate creation is rejected by default", async () => {
  const target = await copyFixture(contentFixture, "create-animation.json");
  const before = await readSpineDocument(target);
  await createAnimation(target, {
    animation: "agent-test",
    dryRun: false,
    expectedHash: before.hash,
  }, testContext);
  const json = (await readSpineDocument(target)).json;
  assert.deepEqual(json.animations["agent-test"], {});

  await assert.rejects(
    () => createAnimation(target, {
      animation: "agent-test",
      dryRun: true,
    }),
    /已存在/,
  );
});

test("clone animation creates an independent target copy", async () => {
  const target = await copyFixture(contentFixture, "clone-animation.json");
  const before = await readSpineDocument(target);
  await cloneAnimation(target, {
    sourceAnimation: "idle",
    targetAnimation: "idle-copy",
    dryRun: false,
    expectedHash: before.hash,
  }, testContext);
  const middle = await readSpineDocument(target);
  await setBoneKeyframe(target, {
    animation: "idle-copy",
    bone: "3",
    timeline: "rotate",
    time: 0.25,
    value: 99,
    dryRun: false,
    expectedHash: middle.hash,
  }, testContext);
  const json = (await readSpineDocument(target)).json;
  assert.notDeepEqual(json.animations.idle, json.animations["idle-copy"]);
  assert.equal(json.animations.idle.bones["3"].rotate.some((keyframe: any) => keyframe.value === 99), false);
});

test("delete animation requires explicit confirmation", async () => {
  const target = await copyFixture(contentFixture, "delete-animation.json");
  await assert.rejects(
    () => deleteAnimation(target, {
      animation: "idle",
      dryRun: true,
    }),
    /confirm: true/,
  );
  const before = await readSpineDocument(target);
  await deleteAnimation(target, {
    animation: "idle",
    confirm: true,
    dryRun: false,
    expectedHash: before.hash,
  }, testContext);
  const json = (await readSpineDocument(target)).json;
  assert.equal(json.animations.idle, undefined);
});

test("animation sheet returns editable keyframe rows", async () => {
  const sheet = getAnimationSheet(await readSpineDocument(contentFixture), "idle", "bone", "3");
  assert.ok(sheet.rowCount > 0);
  assert.ok(sheet.rows.some((row) => row.targetName === "3" && row.timeline === "rotate" && row.time === 0));
});

test("shift keyframes moves selected keyframe times and preserves sorting", async () => {
  const target = await copyFixture(contentFixture, "shift.json");
  const before = await readSpineDocument(target);
  await shiftKeyframes(target, {
    animation: "idle",
    range: { start: 0.5, end: 1 },
    targets: [{ targetType: "bone", names: ["3"], timelines: ["rotate"] }],
    deltaTime: 0.25,
    dryRun: false,
    expectedHash: before.hash,
  }, testContext);
  const keyframes = (await readSpineDocument(target)).json.animations.idle.bones["3"].rotate;
  assert.ok(keyframes.some((keyframe: any) => keyframe.time === 0.75));
  assert.ok(keyframes.some((keyframe: any) => keyframe.time === 1.25));
  assert.deepEqual(keyframes.map((keyframe: any) => keyframe.time ?? 0), [...keyframes].map((keyframe: any) => keyframe.time ?? 0).sort((a, b) => a - b));
});

test("scale keyframe times changes selected timing around origin", async () => {
  const target = await copyFixture(contentFixture, "scale-time.json");
  const before = await readSpineDocument(target);
  await scaleKeyframeTimes(target, {
    animation: "idle",
    range: { start: 0.5, end: 1 },
    originTime: 0,
    scale: 2,
    targets: [{ targetType: "bone", names: ["3"], timelines: ["rotate"] }],
    dryRun: false,
    expectedHash: before.hash,
  }, testContext);
  const keyframes = (await readSpineDocument(target)).json.animations.idle.bones["3"].rotate;
  assert.ok(keyframes.some((keyframe: any) => keyframe.time === 1));
  assert.ok(keyframes.some((keyframe: any) => keyframe.time === 2));
});

test("delete keyframe range removes only selected range", async () => {
  const target = await copyFixture(contentFixture, "delete-range.json");
  const before = await readSpineDocument(target);
  await deleteKeyframeRange(target, {
    animation: "idle",
    range: { start: 0.5, end: 0.5 },
    targets: [{ targetType: "bone", names: ["3"], timelines: ["rotate"] }],
    dryRun: false,
    expectedHash: before.hash,
  }, testContext);
  const keyframes = (await readSpineDocument(target)).json.animations.idle.bones["3"].rotate;
  assert.equal(keyframes.some((keyframe: any) => keyframe.time === 0.5), false);
  assert.equal(keyframes.some((keyframe: any) => (keyframe.time ?? 0) === 0), true);
});

test("copy keyframe range copies selected keys into target animation time", async () => {
  const target = await copyFixture(contentFixture, "copy-range.json");
  let document = await readSpineDocument(target);
  await createAnimation(target, {
    animation: "copy-target",
    dryRun: false,
    expectedHash: document.hash,
  }, testContext);
  document = await readSpineDocument(target);
  await copyKeyframeRange(target, {
    sourceAnimation: "idle",
    targetAnimation: "copy-target",
    sourceRange: { start: 0.5, end: 0.5 },
    targetStartTime: 1.5,
    targets: [{ targetType: "bone", names: ["3"], timelines: ["rotate"] }],
    dryRun: false,
    expectedHash: document.hash,
  }, testContext);
  const keyframes = (await readSpineDocument(target)).json.animations["copy-target"].bones["3"].rotate;
  assert.equal(keyframes.length, 1);
  assert.equal(keyframes[0].time, 1.5);
});

test("apply pose keyframes writes multiple bone and slot timelines at one time", async () => {
  const target = await copyFixture(contentFixture, "pose.json");
  const before = await readSpineDocument(target);
  await applyPoseKeyframes(target, {
    animation: "idle",
    time: 0.25,
    bones: {
      "3": {
        rotate: 11,
        translate: { x: 2, y: 3 },
      },
      "4": {
        scale: { x: 1.2, y: 0.8 },
      },
    },
    slots: {
      "xiaoren-0": { attachmentName: "xiaoren-0" },
    },
    dryRun: false,
    expectedHash: before.hash,
  }, testContext);
  const json = (await readSpineDocument(target)).json;
  assert.equal(json.animations.idle.bones["3"].rotate.find((keyframe: any) => keyframe.time === 0.25).value, 11);
  assert.deepEqual(
    pick(json.animations.idle.bones["3"].translate.find((keyframe: any) => keyframe.time === 0.25), ["x", "y"]),
    { x: 2, y: 3 },
  );
  assert.equal(json.animations.idle.slots["xiaoren-0"].attachment.find((keyframe: any) => keyframe.time === 0.25).name, "xiaoren-0");
});

test("apply pose sequence creates a closed animation in one transaction", async () => {
  const target = await copyFixture(contentFixture, "pose-sequence.json");
  const before = await readSpineDocument(target);
  const result = await applyPoseSequence(target, {
    animation: "sequence-walk",
    duration: 0.6,
    closeLoop: true,
    poses: [
      {
        time: 0,
        curve: [0.25, 0, 0.75, 1],
        bones: {
          bone2: { translate: { y: 0 }, rotate: 0 },
          bone4: { rotate: -3 },
        },
      },
      {
        time: 0.3,
        curve: [0.25, 0, 0.75, 1],
        bones: {
          bone2: { translate: { y: 3 }, rotate: 1 },
          bone4: { rotate: 3 },
        },
      },
    ],
    dryRun: false,
    expectedHash: before.hash,
  }, testContext);
  assert.equal(result.dryRun, false);
  assert.equal(result.operationValidation.ok, true);
  assert.equal(result.officialSpecValidation.ok, true);
  assert.ok(result.backupPath);
  assert.equal(result.affectedPaths.length, 3);
  assert.ok(result.diff.length > result.affectedPaths.length);
  assert.equal(new Set(result.affectedPaths).size, result.affectedPaths.length);
  assert.equal(result.summary.diffEntryCount, result.diff.length);
  assert.equal(result.summary.changedPathCount, 3);

  const backupFiles = await listBackupFiles();
  assert.equal(backupFiles.length, 1);

  const json = (await readSpineDocument(target)).json;
  const bone2Translate = json.animations["sequence-walk"].bones.bone2.translate;
  const bone4Rotate = json.animations["sequence-walk"].bones.bone4.rotate;
  assert.equal(bone2Translate.at(-1).time, 0.6);
  assert.deepEqual(pick(bone2Translate[0], ["y"]), pick(bone2Translate.at(-1), ["y"]));
  assert.deepEqual(pick(bone4Rotate[0], ["value"]), pick(bone4Rotate.at(-1), ["value"]));
  assert.equal(bone2Translate.at(-1).curve, undefined);
  assert.equal(bone4Rotate.at(-1).curve, undefined);
});

test("apply pose sequence dry-run does not change hash and invalid input rejects whole batch", async () => {
  const target = await copyFixture(contentFixture, "pose-sequence-dry-run.json");
  const before = await readSpineDocument(target);
  const result = await applyPoseSequence(target, {
    animation: "sequence-preview",
    duration: 0.6,
    poses: [
      { time: 0, bones: { bone2: { rotate: 0 } } },
      { time: 0.6, bones: { bone2: { rotate: 0 } } },
    ],
    dryRun: true,
    expectedHash: before.hash,
  }, testContext);
  assert.equal(result.dryRun, true);
  assert.equal((await readSpineDocument(target)).hash, before.hash);
  assert.equal(result.hashAfter, null);

  await assert.rejects(
    () => applyPoseSequence(target, {
      animation: "bad-sequence",
      poses: [
        { time: 0, bones: { missing_bone: { rotate: 1 } } },
      ],
      dryRun: true,
      expectedHash: before.hash,
    }, testContext),
    /Bone 'missing_bone' does not exist/,
  );
  assert.equal((await readSpineDocument(target)).hash, before.hash);
});

test("offset bone timeline values adjusts selected rotate keyframes", async () => {
  const target = await copyFixture(contentFixture, "offset.json");
  const before = await readSpineDocument(target);
  await offsetBoneTimelineValues(target, {
    animation: "idle",
    bones: ["3"],
    timeline: "rotate",
    range: { start: 0, end: 0 },
    offset: 10,
    dryRun: false,
    expectedHash: before.hash,
  }, testContext);
  const keyframe = (await readSpineDocument(target)).json.animations.idle.bones["3"].rotate[0];
  assert.equal(keyframe.value, -0.13);
});

test("make loop copies source time keyframes to target time", async () => {
  const target = await copyFixture(contentFixture, "loop.json");
  const before = await readSpineDocument(target);
  await makeLoop(target, {
    animation: "idle",
    sourceTime: 0,
    targetTime: 1.5,
    targets: [{ targetType: "bone", names: ["3"], timelines: ["rotate"] }],
    dryRun: false,
    expectedHash: before.hash,
  }, testContext);
  const keyframe = (await readSpineDocument(target)).json.animations.idle.bones["3"].rotate.find((entry: any) => entry.time === 1.5);
  assert.equal(keyframe.value, -10.13);
});

test("preview helpers expose config, check assets, and generate direct URLs", async () => {
  const config = getPreviewConfig("http://127.0.0.1:6000");
  assert.equal(config.baseUrl, "http://127.0.0.1:6000/");
  assert.equal(config.defaultJson, contentFixture);
  assert.equal(config.defaultAtlas, "preview/xiaoren.atlas");
  assert.equal(config.runtimeMajorMinor, "4.1");

  const assets = await checkPreviewAssets({
    filePath: contentFixture,
    atlasPath: "preview/xiaoren.atlas",
    animation: "walktest2",
  });
  assert.equal(assets.ok, true);
  assert.equal(assets.version, "4.1.24");
  assert.equal(assets.animationExists, true);
  assert.equal(assets.atlas.pages.includes("xiaoren.png"), true);
  assert.ok(assets.images.some((image) => image.path === "preview/xiaoren.png" && image.exists));

  const previewUrl = getPreviewUrl({
    baseUrl: "http://127.0.0.1:6000",
    filePath: contentFixture,
    atlasPath: "preview/xiaoren.atlas",
    animation: "walktest2",
    premultipliedAlpha: false,
    mipmaps: false,
  });
  const url = new URL(previewUrl.url);
  assert.equal(url.searchParams.get("json"), contentFixture);
  assert.equal(url.searchParams.get("atlas"), "preview/xiaoren.atlas");
  assert.equal(url.searchParams.get("animation"), "walktest2");
  assert.equal(url.searchParams.get("pma"), "false");
  assert.equal(url.searchParams.get("autoload"), "true");
});

test("runtime validation loads JSON and atlas through official spine-core", async () => {
  const result = await validatePreviewRuntime({
    filePath: contentFixture,
    atlasPath: "preview/xiaoren.atlas",
    animation: "walktest2",
  });
  assert.equal(result.ok, true);
  assert.equal(result.version, "4.1.24");
  assert.equal(result.runtime.version, "4.1.56");
  assert.equal(result.skeletonData?.bones, 93);
  assert.equal(result.skeletonData?.slots, 33);
  assert.ok(result.skeletonData?.animations.some((animation) => animation.name === "walktest2"));
  assert.ok(result.atlas?.regionCount && result.atlas.regionCount > 0);
});

test("runtime validation reports missing requested animation", async () => {
  const result = await validatePreviewRuntime({
    filePath: contentFixture,
    atlasPath: "preview/xiaoren.atlas",
    animation: "missing-animation",
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes("missing-animation")));
});

test("validation pipeline combines structure, runtime, and preview URL checks", async () => {
  const result = await runValidationPipeline({
    filePath: contentFixture,
    atlasPath: "preview/xiaoren.atlas",
    animation: "walktest2",
    baseUrl: "http://127.0.0.1:6000",
  });
  assert.equal(result.ok, true);
  assert.equal(result.structureValidation.ok, true);
  assert.equal(result.runtimeValidation.ok, true);
  assert.equal(result.checks.length, 3);
  assert.ok(result.previewUrl.url.includes("animation=walktest2"));
  assert.ok(result.recommendedNextSteps.some((step) => step.includes("人工动作观感确认")));
});

test("validation pipeline reports runtime issues without writing files", async () => {
  const before = (await readSpineDocument(contentFixture)).hash;
  const result = await runValidationPipeline({
    filePath: contentFixture,
    atlasPath: "preview/xiaoren.atlas",
    animation: "missing-animation",
  });
  const after = (await readSpineDocument(contentFixture)).hash;
  assert.equal(result.ok, false);
  assert.equal(result.structureValidation.ok, true);
  assert.equal(result.runtimeValidation.ok, false);
  assert.equal(after, before);
  assert.ok(result.recommendedNextSteps.some((step) => step.includes("不要继续")));
});

test("backup tools list and restore a previous valid JSON", async () => {
  const target = await copyFixture(contentFixture, "restore-target.json");
  const original = await readSpineDocument(target);
  await createAnimation(target, {
    animation: "restore-temp",
    dryRun: false,
    expectedHash: original.hash,
  }, testContext);
  const modified = await readSpineDocument(target);
  assert.ok(modified.json.animations["restore-temp"]);

  const backups = await listBackups({ filePath: target }, testContext);
  assert.equal(backups.count, 1);
  assert.equal(backups.backups[0].validation?.ok, true);

  const dryRun = await restoreBackup({
    backupPath: backups.backups[0].backupPath,
    targetFilePath: target,
    dryRun: true,
    expectedHash: modified.hash,
    confirm: true,
  }, testContext);
  assert.equal(dryRun.dryRun, true);
  assert.equal((await readSpineDocument(target)).hash, modified.hash);

  const restored = await restoreBackup({
    backupPath: backups.backups[0].backupPath,
    targetFilePath: target,
    dryRun: false,
    expectedHash: modified.hash,
    confirm: true,
  }, testContext);
  assert.equal(restored.dryRun, false);
  assert.ok(restored.currentBackupPath);
  const restoredDocument = await readSpineDocument(target);
  assert.equal(restoredDocument.json.animations["restore-temp"], undefined);
  assert.equal(validateSpineJson(restoredDocument.json).ok, true);
});

test("restore backup requires confirmation, expected hash, and valid backup JSON", async () => {
  const target = await copyFixture(contentFixture, "restore-guard.json");
  await mkdir(testContext.backupRoot, { recursive: true });
  const invalidBackup = "test-output/backups/restore-guard.bad.json";
  await writeFile(path.join(workspaceRoot, invalidBackup), "{ bad json", "utf8");
  const document = await readSpineDocument(target);

  await assert.rejects(
    () => restoreBackup({
      backupPath: invalidBackup,
      targetFilePath: target,
      dryRun: true,
    } as any, testContext),
    /confirm: true/,
  );

  await assert.rejects(
    () => restoreBackup({
      backupPath: invalidBackup,
      targetFilePath: target,
      dryRun: true,
      expectedHash: "bad-hash",
      confirm: true,
    }, testContext),
    /expectedHash mismatch/,
  );

  await assert.rejects(
    () => restoreBackup({
      backupPath: invalidBackup,
      targetFilePath: target,
      dryRun: false,
      expectedHash: document.hash,
      confirm: true,
    }, testContext),
    /无法解析/,
  );
});

test("preview session stores Agent-driven context for observers", async () => {
  const sessionContext = { workspaceRoot: outputDir, backupRoot: testContext.backupRoot };
  await clearPreviewSession(sessionContext);
  const setResult = await setPreviewSession({
    filePath: contentFixture,
    atlasPath: "preview/xiaoren.atlas",
    animation: "walktest2",
    speed: 1.2,
    premultipliedAlpha: true,
    mipmaps: false,
    autoload: true,
    operation: {
      title: "测试 Agent 会话",
      status: "dryRun",
      toolName: "spine_apply_pose_sequence",
      dryRun: true,
      detail: "只更新预览会话，不写 Spine JSON。",
    },
    log: {
      level: "info",
      message: "已完成 dryRun。",
      toolName: "spine_apply_pose_sequence",
    },
  }, sessionContext);
  assert.equal(setResult.revision, 1);
  assert.equal(setResult.context.animation, "walktest2");
  assert.ok(setResult.previewUrl.url.includes("animation=walktest2"));

  const getResult = await getPreviewSession({ baseUrl: "http://127.0.0.1:6000" }, sessionContext);
  assert.equal(getResult.revision, 1);
  assert.equal(getResult.operation.status, "dryRun");
  assert.equal(getResult.logs.length, 1);
  assert.ok(getResult.previewUrl.url.startsWith("http://127.0.0.1:6000/"));

  const cleared = await clearPreviewSession(sessionContext);
  assert.equal(cleared.revision, 0);
  assert.equal(cleared.context.animation, "walktest2");
});

test("agent connection status turns green after MCP handshake", async () => {
  const agentWorkspace = path.join(outputDir, "agent-workspace");
  await mkdir(path.join(agentWorkspace, "dist"), { recursive: true });
  await writeFile(path.join(agentWorkspace, "AGENTS.md"), "# 项目规则\n", "utf8");
  await writeFile(path.join(agentWorkspace, "dist", "server.js"), "// built server\n", "utf8");

  const context = { workspaceRoot: agentWorkspace };
  const before = await getAgentConnectionStatus({ clientType: "codex" }, context);
  assert.equal(before.selected?.light, "yellow");

  const ping = await agentPing({
    clientType: "codex",
    agentName: "Codex",
    note: "测试握手",
  }, context);
  assert.equal(ping.selected?.light, "green");
  assert.equal(ping.handshake.revision, 1);

  const after = await getAgentConnectionStatus({ clientType: "codex" }, context);
  assert.equal(after.selected?.latestHandshake?.agentName, "Codex");
  assert.match(after.selected?.config.snippet ?? "", /spine-json-mcp/);
});

async function copyFixture(source: string, name: string) {
  const target = `test-output/${name}`;
  await writeFile(path.join(workspaceRoot, target), await readFile(path.join(workspaceRoot, source), "utf8"), "utf8");
  return target;
}

async function listBackupFiles() {
  try {
    const entries = await readdir(testContext.backupRoot);
    return entries.filter((entry) => entry.endsWith(".json"));
  } catch {
    return [];
  }
}

function pick(object: Record<string, any>, keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, object[key]]));
}
