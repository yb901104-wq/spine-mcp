import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedLeastSquares} from '../src/poseRefinementMath.js';
import {torsoAxis,compareGraphs} from '../src/poseGraph.js';
import {graphResiduals} from '../src/referencePoseRefinement.js';
test('握持杆是无向轴，跨180度残差与比较规则一致，不强迫左右握点换位',()=>{
 const r=graphResiduals({metrics:[{id:'grip.direction',reference:30,target:170,error:40,tolerance:15,required:true}]});assert.ok(Math.abs(r[0]+40/15)<1e-8);
});
test('局部修正确定性、边界约束与最多60次；每次接受都降低残差',()=>{
 const settings={bounds:[[0,2],[-2,2]] as Array<[number,number]>,steps:[1e-4,1e-4]},f=(x:number[])=>[x[0]-5,2*x[1]-1];
 const a=boundedLeastSquares([0,0],f,settings),b=boundedLeastSquares([0,0],f,settings);assert.deepEqual(a,b);assert.equal(a.x[0],2);assert.ok(Math.abs(a.x[1]-.5)<1e-4);assert.ok(a.cost>=9);assert.ok(a.iterations<=60);assert.ok(a.history.every((v,i)=>!i||v.cost<a.history[i-1].cost));
});
test('躯干轴来自肩髋，与头中心独立；错误膝弯曲侧和前后站位不能互相抵消',()=>{
 const points:any={head:{x:0,y:130},body:{x:0,y:70},leftHip:{x:-10,y:60},leftKnee:{x:-25,y:30},leftAnkle:{x:-40,y:0},rightHip:{x:10,y:60},rightKnee:{x:25,y:30},rightAnkle:{x:40,y:0},leftShoulder:{x:-10,y:100},leftElbow:{x:15,y:90},leftWrist:{x:35,y:100},rightShoulder:{x:10,y:100},rightElbow:{x:30,y:80},rightWrist:{x:45,y:100}};
 const before=torsoAxis(points);points.head.x=100;assert.deepEqual(torsoAxis(points),before);
 const ref={points:Object.fromEntries(Object.entries(points).map(([k,p]:any)=>[k,{...p,y:-p.y,visibility:'visible'}])),facing:'right',support:{left:true,right:true}},target={points:structuredClone(points),facing:'right',support:{left:true,right:true}},map={left:'left',right:'right',basis:'合成测试',anatomicalIdentity:'同侧',projectedOrder:'固定'};
 target.points.leftKnee.x=5;target.points.leftAnkle.x=50;target.points.rightAnkle.x=-50;
 const bad=compareGraphs(ref,target,map);assert.equal(bad.ok,false);assert.equal(bad.metrics.find(m=>m.id==='stance.order').status,'fail');assert.equal(bad.metrics.find(m=>m.id==='body.torsoDirection').status,'pass');
});
