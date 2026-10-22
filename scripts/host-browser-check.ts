// 浏览器联调只使用临时合成夹具；关闭 Host 后自动清理，不作为真实角色视觉验收。
import { withHostFixture } from '../test/helpers/hostFixture.js';
import { startHostServer } from '../src/hostServer.js';
import { evaluateHostSnapshot } from '../src/hostEvaluator.js';
await withHostFixture(async({context,root})=>{
  const host=await startHostServer(context,{captureTimeoutMs:5000});
  await host.store.open({path:'a.pose.json'});
  const snapshot=await host.store.snapshot(host.store.active!.version),result=await evaluateHostSnapshot(snapshot,context);
  await host.store.publishDerived({expectedRevision:snapshot.version,snapshotHash:snapshot.snapshotHash,dependencyFingerprint:snapshot.dependencyFingerprint,result});
  console.log(JSON.stringify({endpoint:host.endpoint,workspaceRoot:root,mode:'临时合成夹具；不代表美术或编辑器验收',captureTimeoutMs:5000}));
  await new Promise<void>(resolve=>host.server.once('close',()=>resolve()));
});
