import { createHash } from 'node:crypto';
const hash=(value:any)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const referenceFingerprint=(r:any)=>hash({id:r.id,observation:r.observation,imageHash:r.imageHash});
export const visualRigFingerprint=(v:any)=>hash({version:v.version,filePath:v.filePath,mappingPath:v.mappingPath,skin:v.skin,sourceFingerprint:v.sourceFingerprint,nodes:v.nodes,segments:v.segments,anatomicalSides:v.anatomicalSides,viewProfiles:v.viewProfiles,torsoAxis:v.torsoAxis});
export const poseFingerprint=(p:any)=>hash({version:p.version,id:p.id,kind:p.kind,facing:p.facing,frame:p.frame,groundY:p.groundY,standardPosePath:p.standardPosePath,referencePosePath:p.referencePosePath,reference:p.reference,weapon:p.weapon,policy:p.policy,visualRigPath:p.visualRigPath,correspondence:p.correspondence,sequencePath:p.sequencePath,stageId:p.stageId,sourceFingerprint:p.sourceFingerprint,solution:p.solution});
export const legacyEvidenceHash=(raw:Buffer)=>hash(raw.toString('base64'));
