import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCanvas } from '@napi-rs/canvas';
import { createMappingDraft, calibrateMapping, confirmMapping } from '../../src/mappingTools.js';
import { createPoseDraft, solvePose } from '../../src/poseWorkflow.js';
import { registerWorkspace } from '../../src/workspaceTools.js';
import { createProject } from '../../src/projectModel.js';
import type { ProjectManifest } from '../../src/projectSchema.js';
export async function withHostFixture(fn:(fixture:{root:string;context:{workspaceRoot:string;projectId:string};manifest:ProjectManifest})=>Promise<void>,options:{neutralSetup?:boolean}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'spine-host-')),previous=process.env.SPINE_MCP_WORKSPACE;
  process.env.SPINE_MCP_WORKSPACE=root;
  try{
    const context={workspaceRoot:root,projectId:'host-fixture'},bones:any[]=[{name:'root',x:4,y:2,rotation:3},{name:'body',parent:'root',x:2,y:80,rotation:4},{name:'head',parent:'body',x:1,y:25,rotation:5}],mapping:any={character:'隔离机械验证夹具',version:2,atlasPath:'body.atlas',bones:{root:'root',body:'body',head:'head',channels:{torso:'body'},anchors:{},bendDirections:{}}};
    for(const side of ['left','right'])for(const part of ['Leg','Arm']){
      const role=side+part,chain=[role+'1',role+'2',role+'3'],length=part==='Leg'?40:60;
      bones.push({name:chain[0],parent:'body',x:side==='left'?-12:12,y:part==='Leg'?-5:25,rotation:-90,length},{name:chain[1],parent:chain[0],x:length,length},{name:chain[2],parent:chain[1],x:length});
      mapping.bones[role]=chain;mapping.bones.bendDirections[role]=1;mapping.bones.anchors[side+(part==='Leg'?'Foot':'Hand')]={bone:chain[2],point:[0,0],gripPoint:[3,0]};
    }
    const attachment={type:'region',path:'body',width:12,height:24};
    // 独立机械成功夹具；原非零 setup 夹具继续覆盖失败路径，不能当真实美术验收。
    if(options.neutralSetup){bones[0]={...bones[0],x:0,y:0,rotation:0};bones[1]={...bones[1],x:0,rotation:0};bones[2]={...bones[2],x:0,rotation:0};}
    await writeFile(path.join(root,'body.json'),JSON.stringify({skeleton:{spine:'4.1.24'},bones,slots:[{name:'bodySlot',bone:'body',attachment:'body'},{name:'accentSlot',bone:'root',attachment:'body'}],skins:[{name:'default',attachments:{bodySlot:{body:attachment,alternate:{...attachment,width:18}},accentSlot:{body:attachment}}},{name:'alternate',attachments:{bodySlot:{body:{...attachment,height:18}},accentSlot:{body:attachment}}}],animations:{original:{}}}));
    await writeFile(path.join(root,'body.atlas'),'body.png\nsize: 32,32\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\nbody\n  rotate: false\n  xy: 0,0\n  size: 32,32\n  orig: 32,32\n  offset: 0,0\n  index: -1\n');
    const canvas=createCanvas(32,32),ctx=canvas.getContext('2d');ctx.fillStyle='#55bcdd';ctx.fillRect(0,0,32,32);ctx.fillStyle='#efab55';ctx.fillRect(0,0,8,32);await writeFile(path.join(root,'body.png'),canvas.toBuffer('image/png'));
    await registerWorkspace({rootPath:root,projectId:context.projectId});
    await createMappingDraft({filePath:'body.json',mappingPath:'mapping.json',mapping,dryRun:false},context);
    await calibrateMapping({filePath:'body.json',mappingPath:'mapping.json',dryRun:false},context);
    await confirmMapping({filePath:'body.json',mappingPath:'mapping.json',confirmedBy:'隔离测试（不代表真实视觉验收）',semanticChecks:['body','head','sides','chains','anchors','bendDirections','setupPose','followBones'],dryRun:false},context);
    const frame={time:0,body:{x:0,y:.05,rotate:0},head:0,channels:{},targets:{leftFoot:{x:-.15,y:0,angle:-90,contact:true},rightFoot:{x:.15,y:0,angle:-90,contact:true},leftHand:{x:-.15,y:.6,angle:-90},rightHand:{x:.15,y:.6,angle:-90}}};
    for(const posePath of ['a.pose.json','b.pose.json']){await createPoseDraft({filePath:'body.json',mappingPath:'mapping.json',posePath,kind:'standing',frame,dryRun:false},context);await solvePose({posePath,dryRun:false},context);}
    const manifest:ProjectManifest={format:'spine-ai-workspace',schemaVersion:1,projectId:context.projectId,name:'Host 隔离验证工程',characters:{hero:{skeletonPath:'body.json',mappingPath:'mapping.json',atlasPath:'body.atlas',spineVersion:'4.1.24'}},documents:[{path:'a.pose.json',kind:'pose',characterId:'hero'},{path:'b.pose.json',kind:'pose',characterId:'hero'},{path:'body.json',kind:'skeleton',characterId:'hero'}],references:{posePaths:[],sequencePaths:[]},artifactRoots:{previews:'output/previews',reports:'output/reports'}};
    await createProject({manifest,expectedAbsent:true,dryRun:false},context);
    await fn({root,context,manifest});
  }finally{if(previous===undefined)delete process.env.SPINE_MCP_WORKSPACE;else process.env.SPINE_MCP_WORKSPACE=previous;await rm(root,{recursive:true,force:true});}
}
