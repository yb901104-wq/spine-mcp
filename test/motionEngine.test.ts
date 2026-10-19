import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm, copyFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createMappingDraft, calibrateMapping, confirmMapping } from "../src/mappingTools.js";
import { retargetMotion, validateMapping, validateMotion, type CharacterMapping, type MotionDefinition } from "../src/motionEngine.js";
import { readSpineDocument, fitAnimationCurves } from "../src/spineJson.js";
import { extractMotion } from "../src/retargetEngine.js";
import { loadMotionRuntime, worldVertices } from "../src/motionRuntime.js";
import { fitRuntimeAnimation } from '../src/runtimeCurveFit.js';
test('curve mode preserves the linear option and does not mutate source', async () => {
  const json:any={animations:{test:{bones:{root:{rotate:[{time:0,value:0},{time:.5,value:10},{time:1,value:0}]}}}}};
  const snapshot=JSON.stringify(json);
  const linear=await fitRuntimeAnimation(json,'test',{useCurves:false,rotationTolerance:.1},{});
  assert.equal(linear.report.runtimeVerified,false);assert.ok(linear.animation.bones.root.rotate.every((f:any)=>f.curve===undefined));
  const cubic=await fitRuntimeAnimation(json,'test',{useCurves:true,rotationTolerance:.1},{});
  assert.ok(cubic.animation.bones.root.rotate.some((f:any)=>Array.isArray(f.curve)));assert.equal(cubic.animation.bones.root.rotate.at(-1).curve,undefined);assert.equal(JSON.stringify(json),snapshot);
});
const checks = ["body", "head", "sides", "chains", "anchors", "bendDirections", "setupPose", "followBones"];
async function fixture(prefix = "a", factor = 1, workspace?: string) {
  const workspaceRoot = workspace ?? await mkdtemp(path.join(os.tmpdir(), "spine-motion-"));
  const n = (x: string) => prefix + "_" + x;
  const bones: any[] = [{ name: n("root") }, { name: n("body"), parent: n("root"), y: 80 * factor }, { name: n("head"), parent: n("body"), y: 25 * factor }];
  const mapping: CharacterMapping = { character: prefix, version: 2, atlasPath: "empty.atlas", bones: { root: n("root"), body: n("body"), head: n("head"), anchors: {}, bendDirections: {}, follow: [] } };
  for (const side of ["left", "right"] as const) for (const part of ["Leg", "Arm"] as const) {
    const role = `${side}${part}` as const, chain = [n(role + "1"), n(role + "2"), n(role + "3")];
    const length = part === "Leg" ? 40 * factor : 60 * factor;
    bones.push({ name: chain[0], parent: n("body"), x: (side === "left" ? -1 : 1) * 12 * factor, y: part === "Leg" ? -5 * factor : 25 * factor, rotation: -90, length }, { name: chain[1], parent: chain[0], x: length, length }, { name: chain[2], parent: chain[1], x: length, length: 10 * factor });
    mapping.bones[role] = chain; mapping.bones.bendDirections![role] = 1;
    mapping.bones.anchors![`${side}${part === "Leg" ? "Foot" : "Hand"}`] = { bone: chain[2], point: [0, 0] };
  }
  const filePath = prefix + ".json", mappingPath = prefix + ".mapping.json", context = { workspaceRoot, backupRoot: path.join(workspaceRoot, "backups") };
  if (prefix === 'b') {
    bones.splice(1, 0, { name: n('torsoPivot'), parent: n('root') });
    bones.find(b => b.name === n('body')).parent = n('torsoPivot');
    bones.push({ name: n('accessory'), parent: n('head'), y: 10 * factor });
  }
  await writeFile(path.join(workspaceRoot, filePath), JSON.stringify({ skeleton: { spine: "4.1.24" }, bones, slots: [], skins: [], animations: { original: {} } }));
  await writeFile(path.join(workspaceRoot, "empty.atlas"), "");
  await createMappingDraft({ filePath, mappingPath, mapping, dryRun: false }, context);
  await calibrateMapping({ filePath, mappingPath, dryRun: false }, context);
  await confirmMapping({ filePath, mappingPath, confirmedBy: "test-fixture", semanticChecks: checks, dryRun: false }, context);
  return { filePath, mappingPath, context, mapping: JSON.parse(await readFile(path.join(workspaceRoot, mappingPath), "utf8")) as CharacterMapping };
}
function walk(): MotionDefinition {
  const frames = Array.from({ length: 73 }, (_, i) => {
    const phase = i === 72 ? 0 : i / 72 * 2 * Math.PI;
    return { time: i / 72 * 1.2, body: { x: 0, y: .015 * Math.sin(phase * 2) ** 2, rotate: 0 }, targets: {
      leftFoot: { x: -.03 + .02 * Math.sin(phase), y: .02 * Math.max(0, Math.sin(phase)), angle: -90, contact: Math.sin(phase) <= 0 },
      rightFoot: { x: .03 - .02 * Math.sin(phase), y: .02 * Math.max(0, -Math.sin(phase)), angle: -90, contact: Math.sin(phase) >= 0 },
      leftHand: { x: -.03, y: .4, angle: -90 }, rightHand: { x: .03, y: .4, angle: -90 },
    } };
  });
  frames[72] = { ...structuredClone(frames[0]), time: 1.2 };
  return { name: "walk", version: 2, duration: 1.2, loop: true, coordinateSystem: "normalizedSkeleton", groundY: 0, frames };
}
test('failed diagnostic animation renders but cannot authorize or change character',async()=>{
  const f=await fixture('diagnostic');
  try {
    const motion=walk();for(const frame of motion.frames!)frame.targets.leftHand={x:100,y:100,angle:0};
    await writeFile(path.join(f.context.workspaceRoot,'diagnostic.motion.json'),JSON.stringify(motion));
    const before=await readFile(path.join(f.context.workspaceRoot,f.filePath));
    const args={filePath:f.filePath,mappingPath:f.mappingPath,motionPath:'diagnostic.motion.json',animation:'diagnostic',diagnosticPreview:true,preview:false};
    const result:any=await retargetMotion(args,f.context);
    assert.equal(result.ok,false);assert.equal(result.numericOk,false);assert.equal(result.diagnosticOnly,true);
    assert.equal(result.readyToCommit,false);assert.equal(result.reviewToken,undefined);assert.ok(result.unreachable.length);
    assert.ok(result.animationPreview.gifPath);assert.deepEqual(await readFile(path.join(f.context.workspaceRoot,f.filePath)),before);
    const candidate=JSON.parse(await readFile(path.join(f.context.workspaceRoot,result.candidatePath),'utf8'));
    assert.deepEqual(candidate.animations.original,{});
    await assert.rejects(()=>retargetMotion({...args,dryRun:false},f.context),/仅支持 dryRun/);
  } finally {await rm(f.context.workspaceRoot,{recursive:true,force:true});}
});
test('reference extraction puts support and first release pose on the same ground',async()=>{
  const f=await fixture('contact');
  try {
    const json=JSON.parse(await readFile(path.join(f.context.workspaceRoot,f.filePath),'utf8'));
    json.animations.reference={bones:{[f.mapping.bones.body]:{translate:[{time:0,y:0},{time:1,y:1}]}}};
    await writeFile(path.join(f.context.workspaceRoot,f.filePath),JSON.stringify(json));
    await calibrateMapping({filePath:f.filePath,mappingPath:f.mappingPath,dryRun:false},f.context);
    await confirmMapping({filePath:f.filePath,mappingPath:f.mappingPath,confirmedBy:'test',semanticChecks:checks,dryRun:false},f.context);
    const extraction=await extractMotion({filePath:f.filePath,mappingPath:f.mappingPath,animation:'reference',motionPath:'reference.motion.json',loop:false,samples:11,groundY:-5,contactTolerance:.21},f.context);
    const frames=extraction.motion.frames!;let releases=0;
    for(let i=1;i<frames.length;i++)if(frames[i-1].targets.leftFoot!.contact&&!frames[i].targets.leftFoot!.contact){assert.equal(frames[i].targets.leftFoot!.y,extraction.motion.groundY);releases++;}
    assert.equal(releases,1);
  } finally {await rm(f.context.workspaceRoot,{recursive:true,force:true});}
});
test('v2 idle and run use the same solver, preserve animations and generate preview reports', async () => {
  const f = await fixture('basic');
  try {
    for (const mode of ['idle','run']) {
      const motion = walk(); motion.name = mode;
      if (mode === 'idle') for (const frame of motion.frames!) { frame.targets.leftFoot = { x: -.03, y: 0, angle: -90, contact: true }; frame.targets.rightFoot = { x: .03, y: 0, angle: -90, contact: true }; }
      await writeFile(path.join(f.context.workspaceRoot, `${mode}.json`), JSON.stringify(motion));
      const args = { filePath: f.filePath, mappingPath: f.mappingPath, motionPath: `${mode}.json`, animation: mode, footContactTolerance: .2, handTolerance: 30, rotationTolerance: .00001, translationTolerance: .00001 };
      const before = await readSpineDocument(f.filePath, f.context), review = await retargetMotion(args, f.context);
      assert.equal(review.ok, true); assert.equal(review.preview.ok, true); assert.ok(review.preview.contactSheet); assert.ok(review.reportPath);
      assert.equal(review.poseGate.ok,false);
      await assert.rejects(()=>retargetMotion({...args,dryRun:false,expectedHash:before.hash,reviewToken:review.reviewToken},f.context),/姿态审查/);
      const candidate=JSON.parse(await readFile(path.join(f.context.workspaceRoot,review.candidatePath),'utf8'));
      assert.deepEqual(candidate.animations.original,{});
      const runtime=await loadMotionRuntime(candidate,'empty.atlas',f.context);assert.ok(runtime.data.findAnimation(mode));

    }
  } finally { await rm(f.context.workspaceRoot, { recursive: true, force: true }); }
});
test("same semantic walk retargets to renamed and scaled rigs with review gates", async () => {
  const a = await fixture();
  try {
    const b = await fixture("b", .75, a.context.workspaceRoot);
    await writeFile(path.join(a.context.workspaceRoot, "walk.json"), JSON.stringify(walk()));
    for (const rig of [a, b]) {
      const before = await readSpineDocument(rig.filePath, rig.context);
      const args = { filePath: rig.filePath, mappingPath: rig.mappingPath, motionPath: "walk.json", animation: "walk", rotationTolerance: .00001, translationTolerance: .00001 };
      const review = await retargetMotion({ ...args, dryRun: true, footContactTolerance: .2, handTolerance: 30 }, rig.context);
      assert.equal(review.ok, true, JSON.stringify(review.validation));
      assert.ok(review.motionValidation.maxRotationError <= args.rotationTolerance + 1e-8);
      assert.ok(review.motionValidation.maxTranslationError <= args.translationTolerance + 1e-8);
      assert.equal((await readSpineDocument(rig.filePath, rig.context)).hash, before.hash);
      await assert.rejects(()=>retargetMotion({...args,dryRun:false,expectedHash:before.hash,reviewToken:review.reviewToken,footContactTolerance:.2,handTolerance:30},rig.context),/姿态审查/);
      assert.equal((await readSpineDocument(rig.filePath,rig.context)).hash,before.hash);
      const candidate=JSON.parse(await readFile(path.join(rig.context.workspaceRoot,review.candidatePath),'utf8'));
      assert.deepEqual(candidate.bones,before.json.bones);assert.deepEqual(candidate.animations.original,before.json.animations.original);

    }
  } finally { await rm(a.context.workspaceRoot, { recursive: true, force: true }); }
});
test("schema rejects shared limbs, invalid events and open loops", () => {
  assert.throws(() => validateMapping({ character: "bad", version: 2, bones: { body: "body", leftLeg: ["a", "b", "c"], rightLeg: ["a", "b", "c"] } }), /重复/);
  const motion = walk(); motion.events = [{ time: -1, type: "contact" }]; assert.throws(() => validateMotion(motion), /事件/);
  delete motion.events; motion.frames!.at(-1)!.body.y = 100; assert.throws(() => validateMotion(motion), /首尾/);
});
test("draft, changed calibration and unreachable targets cannot commit", async () => {
  const f = await fixture();
  try {
    const motion = walk(); motion.frames!.forEach(frame => frame.targets.leftFoot!.x = 10);
    await writeFile(path.join(f.context.workspaceRoot, "bad.json"), JSON.stringify(motion));
    const before = await readSpineDocument(f.filePath, f.context);
    const args = { filePath: f.filePath, mappingPath: f.mappingPath, motionPath: "bad.json", animation: "bad" };
    const result = await retargetMotion({ ...args, dryRun: false, expectedHash: before.hash }, f.context);
    assert.equal(result.ok, false); assert.equal((await readSpineDocument(f.filePath, f.context)).hash, before.hash);
    const m = JSON.parse(await readFile(path.join(f.context.workspaceRoot, f.mappingPath), "utf8")); m.status = "draft";
    await writeFile(path.join(f.context.workspaceRoot, f.mappingPath), JSON.stringify(m));
    await assert.rejects(() => retargetMotion({ ...args, dryRun: true }, f.context), /confirmed/);
    m.status = "confirmed"; m.bones.anchors.leftFoot.point[0] = 1;
    await writeFile(path.join(f.context.workspaceRoot, f.mappingPath), JSON.stringify(m));
    await assert.rejects(() => retargetMotion({ ...args, dryRun: true }, f.context), /改变/);
  } finally { await rm(f.context.workspaceRoot, { recursive: true, force: true }); }
});
