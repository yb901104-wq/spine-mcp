import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeReferenceParts,outlineAxis,validateReferenceParts} from '../src/referenceParts.js';
import {compareGraphs} from '../src/poseGraph.js';
import {graphResiduals} from '../src/referencePoseRefinement.js';
import {withHostFixture} from './helpers/hostFixture.js';
import {withV2} from './helpers/referenceV2.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readFile,writeFile} from 'node:fs/promises';
import {requireReferencePose} from '../src/referencePose.js';
import path from 'node:path';
const point=(x:number,y:number,radius=1)=>({x,y,visibility:'visible',uncertaintyRadius:radius});
const rectangle=[{x:0,y:-4},{x:80,y:-4},{x:80,y:4},{x:0,y:4}];
const observation=()=>({points:{leftShoulder:point(0,0),leftElbow:point(80,0)},parts:{'leftArm.0':{source:'rigidSlice',outline:rectangle,radius:.1,basis:'测试刚性轮廓'}}});
test('端点误差随短肢体放大，置信度不会被当作像素误差',()=>{
  const r=observation(),a=analyzeReferenceParts(r);assert.equal(a.ok,true);
  const short=structuredClone(r);short.points.leftElbow.x=10;
  assert.ok(analyzeReferenceParts(short).parts[0].pointHalfAngle!>a.parts[0].pointHalfAngle!);
  const unknown:any=structuredClone(r);delete unknown.points.leftElbow.uncertaintyRadius;unknown.points.leftElbow.confidence=1;
  const fallback=analyzeReferenceParts(unknown);assert.equal(fallback.ok,true);assert.equal(fallback.parts[0].method,'twoPoint');assert.equal(fallback.parts[0].pointHalfAngle,null);assert.equal(fallback.parts[0].uncertaintyKnown,false);
  const overlap=structuredClone(r);overlap.points.leftElbow.uncertaintyRadius=80;assert.equal(analyzeReferenceParts(overlap).parts[0].pointHalfAngle,null);
});
test('轮廓不确定、近圆或衣袖时回退连线；可靠主轴与节点相互冲突仍不自动批准',()=>{
  const circle=Array.from({length:32},(_,i)=>({x:20+10*Math.cos(i*Math.PI/16),y:10*Math.sin(i*Math.PI/16)}));
  for(const patch of [{outline:circle},{source:'clothing'},{radius:30}]){
    const r=observation();Object.assign(r.parts['leftArm.0'],patch);const result=analyzeReferenceParts(r);assert.equal(result.ok,true);assert.equal(result.parts[0].method,'twoPoint');assert.equal(result.parts[0].reliability,'estimated');
  }
  const conflict=observation();conflict.parts['leftArm.0'].outline=rectangle.map(p=>({x:p.y,y:p.x}));assert.equal(analyzeReferenceParts(conflict).parts[0].method,'conflict');assert.equal(analyzeReferenceParts(conflict).ok,false);
  assert.equal(outlineAxis([{x:0,y:0},{x:0,y:0},{x:0,y:0}],0),null);
  assert.equal(outlineAxis([{x:0,y:0},{x:20,y:0},{x:40,y:0},{x:60,y:0}],0),null);
  assert.throws(()=>validateReferenceParts({parts:{__invalid:{source:'rigidSlice',basis:'x'}}}),/部件/);
});
test('声明部件后新增方向门禁；误差不会扩大旧角度门限或把未知变成通过',()=>{
  const r:any=observation();r.facing='right';
  const target={facing:'right',points:{leftShoulder:point(0,0),leftElbow:point(80,0)}};
  const correspondence={left:'left',right:'right',basis:'test',anatomicalIdentity:'test',projectedOrder:'test'};
  const good=compareGraphs(r,target,correspondence);assert.equal(good.metrics.find(m=>m.id==='part.leftArm.0.axis').status,'pass');
  r.points.leftElbow.uncertaintyRadius=80;
  const bad=compareGraphs(r,target,correspondence);assert.equal(bad.metrics.find(m=>m.id==='part.leftArm.0.certainty').status,'unverifiable');
  assert.equal(bad.metrics.find(m=>m.id==='part.leftArm.0.certainty').required,false);assert.equal(bad.metrics.find(m=>m.id==='part.leftArm.0.availability').status,'pass');
  assert.equal(bad.metrics.find(m=>m.id==='leftArm.segment0').tolerance,15);
  assert.deepEqual(graphResiduals({metrics:[{id:'part.leftArm.0.certainty',required:true,error:0,reference:'measurable',target:null},{id:'part.leftArm.0.axis',required:true,error:0,reference:179,target:-1,tolerance:15}]}),[0]);
});
test('遮挡回退仍给数值方向，不伪造误差圆；节点未知或重合给明确缺项结果',()=>{
  const r:any={points:{leftShoulder:{x:1,y:2,visibility:'occluded'},leftElbow:{x:11,y:12,visibility:'occluded'}},parts:{'leftArm.0':{source:'unknown',basis:'被袖口遮挡，使用已估计的两个连接点'}}};
  const result=analyzeReferenceParts(r);assert.equal(result.ok,true);assert.equal(result.parts[0].directionDegrees,45);assert.equal(result.parts[0].method,'twoPoint');assert.equal(result.parts[0].pointHalfAngle,null);
  r.points.leftElbow={visibility:'unknown'};const missing=analyzeReferenceParts(r);assert.equal(missing.ok,false);assert.equal(missing.parts[0].directionDegrees,null);assert.equal(missing.parts[0].method,'unavailable');
  r.points.leftElbow={x:1,y:2,visibility:'visible'};assert.equal(analyzeReferenceParts(r).parts[0].method,'unavailable');
});
test('真实 MCP 部件分析：未知不批准、默认不落盘、报告不可覆盖输入且路径越界拒绝',async()=>withHostFixture(async({root,context})=>{
  const protocol=new Client({name:'reference-parts-test',version:'1'},{capabilities:{}});
  const env=Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string')) as Record<string,string>;
  try{
    await protocol.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...env,SPINE_HOST_AUTOSTART:'0'}}));
    const call=async(name:string,args:any)=>{const response=await protocol.callTool({name,arguments:{projectId:context.projectId,...args}});return {response,value:JSON.parse((response.content as any[]).filter(v=>v.type==='text').map(v=>v.text).join('\n'))};};
    const observation=withV2({imagePath:'body.png',time:0,facing:'right',crop:[0,0,32,32],height:30,groundY:30,basis:'合成未知部件，仅作协议测试',points:{},parts:{'leftArm.0':{source:'unknown',basis:'肩肘与轮廓均无法确认'}}});
    assert.equal((await call('spine_create_reference_pose',{referencePosePath:'unknown.reference.json',observation,dryRun:false})).response.isError,undefined);
    const analysis=await call('spine_analyze_reference_parts',{referencePosePath:'unknown.reference.json'});assert.equal(analysis.value.ok,false);assert.equal(analysis.value.parts[0].status,'unverifiable');
    const sheet=await call('spine_render_reference_pose_sheet',{referencePosePaths:['unknown.reference.json'],outputDir:'unknown-sheet'});
    const review=await call('spine_review_reference_pose',{referencePosePath:'unknown.reference.json',manifestPath:sheet.value.manifestPath,decision:'approved',reviewedBy:'test',reason:'不得把未知判过',checks:['jointLocations','visibility','connections','facing','support','uncertainty','orientation','depth','silhouette']});assert.equal(review.response.isError,true);assert.match(review.value.message,/部件观测/);
    const original=await readFile(path.join(root,'body.json'));
    assert.equal((await call('spine_analyze_reference_parts',{referencePosePath:'unknown.reference.json',reportPath:'body.json',dryRun:false})).response.isError,true);assert.deepEqual(await readFile(path.join(root,'body.json')),original);
    assert.equal((await call('spine_analyze_reference_parts',{referencePosePath:'../outside.json'})).response.isError,true);
    const fallback=structuredClone(observation);fallback.points.leftShoulder={x:5,y:5,visibility:'occluded',estimated:true,confidence:.5,basis:'合成肩点估计'};fallback.points.leftElbow={x:15,y:15,visibility:'occluded',estimated:true,confidence:.5,basis:'合成肘点估计'};
    await call('spine_create_reference_pose',{referencePosePath:'fallback.reference.json',observation:fallback,dryRun:false});
    const fallbackSheet=await call('spine_render_reference_pose_sheet',{referencePosePaths:['fallback.reference.json'],outputDir:'fallback-sheet'});
    const approved=await call('spine_review_reference_pose',{referencePosePath:'fallback.reference.json',manifestPath:fallbackSheet.value.manifestPath,decision:'approved',reviewedBy:'test',reason:'合成回退流程：遮挡点为估计，缺误差半径不补造',checks:['jointLocations','visibility','connections','facing','support','uncertainty','orientation','depth','silhouette'],dryRun:false});
    assert.equal(approved.response.isError,undefined);assert.equal(approved.value.review.partMethods[0].method,'twoPoint');assert.equal(approved.value.review.partMethods[0].uncertaintyKnown,false);
    const record=await requireReferencePose('fallback.reference.json',context);record.review.partsPolicyVersion=1;await writeFile(path.join(root,'fallback.reference.json'),JSON.stringify(record));await assert.rejects(requireReferencePose('fallback.reference.json',context),/策略已改变/);
  }finally{await protocol.close();}
}));
