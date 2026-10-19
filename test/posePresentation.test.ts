import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {applyPosePresentation,presentationTimelines} from '../src/posePresentation.js';
import {loadMotionRuntime} from '../src/motionRuntime.js';import {validateOfficialAnimationSpec} from '../src/spineJson.js';
import {semanticAt} from '../src/retargetEngine.js';
test('姿态附件与层序按阶段导出，官方runtime回读边界一致且不改setup',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'spine-presentation-'));
 try{await writeFile(path.join(root,'empty.atlas'),'');const json:any={skeleton:{spine:'4.1.24'},bones:[{name:'root'}],slots:[{name:'body',bone:'root'},{name:'hand',bone:'root'}],skins:[],animations:{}};const before=JSON.stringify(json);
 const motion:any={duration:1,frames:[{time:0,body:{x:0,y:0,rotate:0},targets:{},action:{driver:'rightHand'}},{time:.5,body:{x:0,y:0,rotate:0},targets:{},action:{driver:'rightHand'},presentation:{attachments:{body:null},drawOrder:['hand','body']}},{time:1,body:{x:0,y:0,rotate:0},targets:{}}]};
 assert.equal(semanticAt(motion,.49).presentation,undefined);assert.deepEqual(semanticAt(motion,.5).presentation,motion.frames[1].presentation);assert.equal(semanticAt(motion,.5).action?.driver,'rightHand');
 const animation=presentationTimelines(json,{bones:{}},motion,1);const candidate=structuredClone(json);candidate.animations.test=animation;assert.equal(validateOfficialAnimationSpec(candidate).ok,true);
 const rt=await loadMotionRuntime(candidate,'empty.atlas',{workspaceRoot:root});assert.deepEqual(rt.sample('test',.49).drawOrder.map(s=>s.data.name),['body','hand']);assert.deepEqual(rt.sample('test',.5).drawOrder.map(s=>s.data.name),['hand','body']);assert.deepEqual(rt.sample('test',1).drawOrder.map(s=>s.data.name),['body','hand']);
 assert.throws(()=>applyPosePresentation(rt.skeleton,{drawOrder:['body','body']}),/唯一排列/);assert.throws(()=>applyPosePresentation(rt.skeleton,{attachments:{missing:null}}),/不存在/);assert.equal(JSON.stringify(json),before);
 }finally{await rm(root,{recursive:true,force:true});}
});
