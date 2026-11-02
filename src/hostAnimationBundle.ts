import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {derivedFingerprint,HostError,strictHash} from './hostContracts.js';
import {resolveWorkspacePath,type ToolContext} from './spineJson.js';
import {hashObject,mappingFingerprint} from './mappingTools.js';
import {renderPoseComparison} from './poseWorkflow.js';
import {renderAnimationGif} from './previewRenderTools.js';
import {writeAnimationRecord,type AnimationSession} from './hostAnimationSession.js';

/** MCP 制作完整审查产物与准备令牌；令牌不是批准或 Host 提交授权。 */
export async function createHostAnimationBundle(snapshot:any,derived:any,candidate:any,mapping:any,args:any,gate:any,reportPath:string,context:ToolContext,verify:()=>Promise<void>){
 const keys=snapshot.document.poseWorkflow?.keyPoses;
 if(!Array.isArray(keys)||keys.length>60)throw new HostError('CAPABILITY_MISSING','当前完整姿态联系图最多 60 个已审查关键姿态；请明确阶段范围，不省略审查。',409);
 const dir=path.posix.join(path.posix.dirname(derived.live.path),'reviews',randomUUID());
 await verify();
 const poses=await renderPoseComparison({posePaths:keys.map((k:any)=>k.posePath),targetTimes:keys.map((k:any)=>k.time),stageIds:keys.map((k:any)=>k.stageId),outputDir:dir+'/poses'},context);
 const animation=await renderAnimationGif({filePath:args.filePath,atlasPath:mapping.atlasPath,skin:mapping.skin,animation:args.animation,jsonOverride:candidate,frames:Math.min(240,Math.max(2,Math.ceil(snapshot.document.duration*30))),fps:30,width:320,height:320,bounds:poses.bounds,outputDir:dir+'/animation'},context);
 await verify();
 const read=(p:string)=>readFile(resolveWorkspacePath(p,context));
 const manifest=JSON.parse((await read(animation.manifestPath)).toString()),paths=new Set<string>([derived.live.path,reportPath,poses.manifestPath,animation.manifestPath,animation.gifPath,...manifest.frames??[]]);
 for(const file of poses.evidence??[])paths.add(file.filePath);
 for(const page of poses.pages??[])for(const field of ['clean','diagnostic'])if(page[field])paths.add(page[field]);
 if(mapping.reportPath)paths.add(mapping.reportPath);
 const artifacts=[];for(const filePath of [...paths].sort())artifacts.push({filePath,hash:strictHash(await read(filePath))});
 const binding={version:snapshot.version,snapshotHash:snapshot.snapshotHash,dependencyFingerprint:snapshot.dependencyFingerprint,derivedHash:derivedFingerprint(snapshot.snapshotHash,derived),candidateHash:derived.live.hash,sourceHash:strictHash(await read(args.filePath))};
 const tokenData={poseReview:gate.fingerprint,fileHash:binding.sourceHash,mapping:mappingFingerprint(mapping),motion:hashObject(snapshot.document),animation:args.animation,value:hashObject(candidate.animations[args.animation]),thresholds:[args.footContactTolerance,args.handTolerance,args.vertexTolerance],overwrite:args.overwrite??false,hostBinding:binding,artifacts:hashObject(artifacts)};
 const baseToken=hashObject(tokenData),recordPath=`.spine-mcp/reviews/${baseToken}.json`;
 const record={tokenData,reviewToken:baseToken,candidatePath:derived.live.path,candidateHash:hashObject(candidate),sourcePath:args.filePath,sourceHash:binding.sourceHash,mappingPath:args.mappingPath,motionPath:snapshot.path,duration:snapshot.document.duration,reportPath,requiresReferenceComparison:!!poses.reference,poseManifestPath:poses.manifestPath,previewManifestPath:animation.manifestPath,numericOk:true,keyGraphsOk:true,artifacts};
 await verify();const recordHash=await writeAnimationRecord(recordPath,record,context);await verify();
 const session:AnimationSession={...binding,candidatePath:derived.live.path,sourcePath:args.filePath,animation:args.animation,baseToken,recordPath,recordHash,poseManifestPath:poses.manifestPath,previewManifestPath:animation.manifestPath};
 return {session,posePreview:poses,animationPreview:animation};
}
