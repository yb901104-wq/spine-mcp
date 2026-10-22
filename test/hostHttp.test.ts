import test from 'node:test';
import assert from 'node:assert/strict';
import { withHostFixture } from './helpers/hostFixture.js';
import { startHostServer } from '../src/hostServer.js';
import { evaluateHostSnapshot } from '../src/hostEvaluator.js';
import { strictHash } from '../src/hostContracts.js';
test('Host HTTP：token/Origin/控制隔离、只读状态、版本、体限、限流与截图超时',async()=>withHostFixture(async({context})=>{
  const host=await startHostServer(context,{persist:false,captureTimeoutMs:40});
  const headers={'X-Spine-Host-Token':host.token},control={'X-Spine-Host-Control':host.control};
  const post=(route:string,args:any,extra:Record<string,string>={},origin=host.endpoint)=>fetch(host.endpoint+route,{method:'POST',headers:{...headers,'Content-Type':'application/json',Origin:origin,...extra},body:JSON.stringify(args)});
  try{
    assert.equal((await fetch(host.endpoint+'/api/state')).status,403);
    assert.equal((await post('/api/open',{path:'a.pose.json'},{},'http://foreign.invalid')).status,403);
    assert.equal((await fetch(host.endpoint+'/api/open',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'})).status,403);
    assert.equal((await post('/api/open',{path:'a.pose.json'})).status,200);
    const version=host.store.active!.version;
    assert.equal((await post('/api/snapshot',{expectedRevision:version})).status,403);
    assert.equal((await post('/api/snapshot',{expectedRevision:version},control)).status,200);
    assert.equal((await post('/api/authorize',{expectedRevision:version,approved:true})).status,403);
    assert.equal((await post('/api/state',{version:{revision:999}})).status,400);
    assert.equal((await post('/api/state',{heartbeat:true,loaded:false,playing:false})).status,200);
    assert.equal((await post('/api/open',{path:'../escape.json',expectedRevision:version})).status,403);
    assert.equal((await post('/api/state',{padding:'x'.repeat(256*1024)})).status,413);
    const snapshot=await host.store.snapshot(version),result=await evaluateHostSnapshot(snapshot,context);
    assert.equal((await post('/api/derived',{expectedRevision:version,snapshotHash:snapshot.snapshotHash,dependencyFingerprint:snapshot.dependencyFingerprint,result})).status,403);
    assert.equal((await post('/api/derived',{expectedRevision:version,snapshotHash:snapshot.snapshotHash,dependencyFingerprint:snapshot.dependencyFingerprint,result},control)).status,200);
    assert.equal((await post('/api/derived',{expectedRevision:version,snapshotHash:snapshot.snapshotHash,dependencyFingerprint:snapshot.dependencyFingerprint,result:{...result,review:{decision:'approved'}}},control)).status,400);
    const query=new URLSearchParams({...version,revision:String(version.revision),size:'320'}),url=host.endpoint+'/api/frame?'+query;
    const png=await fetch(url,{headers});assert.equal(png.status,200);assert.equal(png.headers.get('x-open-epoch'),version.openEpoch);
    const first=strictHash(Buffer.from(await png.arrayBuffer()));const second=await fetch(url,{headers});assert.equal(strictHash(Buffer.from(await second.arrayBuffer())),first);
    assert.equal((await fetch(host.endpoint+'/api/frame?size=320',{headers})).status,409);
    const many=await Promise.all(Array.from({length:21},()=>fetch(url,{headers})));assert.ok(many.some(response=>response.status===429));
    const capture=await post('/api/capture',{expectedRevision:version,size:320});assert.equal(capture.status,408);assert.equal((await capture.json()).code,'CAPTURE_TIMEOUT');
    const html=await(await fetch(host.endpoint)).text();assert.ok(html.includes(host.token));assert.equal(html.includes(host.control),false);
  }finally{await host.stop();}
}));
