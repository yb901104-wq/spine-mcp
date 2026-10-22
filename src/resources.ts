import { readFile,stat } from 'node:fs/promises';
import { getWorkspaceTree,relativeInput } from './workspaceTree.js';
import { getWorkspaceContext,runInWorkspace } from './workspaceTools.js';
import { getSkeletonHierarchy,getSlots,readSpineDocument,resolveWorkspacePath } from './spineJson.js';
import { hostClient } from './hostClient.js';
import { poseDigest } from './poseDigest.js';
import { ToolError } from './toolError.js';
import { checkProjectSchema,projectManifestSchema } from './projectSchema.js';

export const resourceTemplates=[
  ['pose','姿态文件'],['reference','参考标注'],['rig','视觉绑定'],['metrics','姿态指标摘要'],
].map(([kind,name])=>({uriTemplate:`spine://${kind}/{path}`,name,description:'路径使用 encodeURIComponent 编码；只读且限制在已选择工作区。',mimeType:'application/json'})).concat([
  {uriTemplate:'spine://doc/{path}/bones',name:'骨骼层级',description:'当前 Spine 文件的骨骼层级；只读。',mimeType:'application/json'},
  {uriTemplate:'spine://doc/{path}/slots',name:'插槽',description:'当前 Spine 文件的插槽；只读。',mimeType:'application/json'},
]);
export async function listResources(cursor?:string){
  const context=getWorkspaceContext(),declared=new Map<string,string>();
  // 只检查清单形状，不遍历依赖、求解或启动 Host。无特殊文件名的受管姿态同样可发现。
  try{
    const manifestPath=resolveWorkspacePath('.spine-workflow.json',context);
    if((await stat(manifestPath)).size<=1024*1024){
      const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
      checkProjectSchema(manifest,projectManifestSchema);
      {
        for(const doc of manifest.documents)if(doc.kind==='pose')declared.set(relativeInput(doc.path),'pose');
        for(const ref of manifest.references.posePaths)declared.set(relativeInput(ref),'reference');
        for(const character of Object.values(manifest.characters) as any[])if(character.visualRigPath)declared.set(relativeInput(character.visualRigPath),'rig');
      }
    }
  }catch(error:any){if(error.code!=='ENOENT')throw error;}
  const resources:any[]=cursor?[]:[{uri:'spine://session',name:'当前工程与会话',mimeType:'application/json',description:'与 spine_preview_state 同源；不启动宿主、不自动选姿态。'}];
  let next=cursor;
  for(let scanned=0;scanned<25;scanned++){
    const before=next,tree=await getWorkspaceTree({depth:2,maxEntries:500,pageSize:1,cursor:next},context),entry=tree.entries[0];
    next=tree.nextCursor??undefined;
    if(entry?.type==='file'&&entry.path.endsWith('.json')){
      const kind=declared.get(entry.path)??(entry.kind==='pose'?'pose':/reference|参考/i.test(entry.path)?'reference':/rig/i.test(entry.path)?'rig':null);
      if(kind){
        const resource={uri:`spine://${kind}/${encodeURIComponent(entry.path)}`,name:entry.path,mimeType:'application/json'};
        if(Buffer.byteLength(JSON.stringify({resources:[...resources,resource]}))>4500){if(resources.length===0||before===undefined)throw new ToolError('CAPABILITY_MISSING','单条资源 URI 超过列表预算，请使用资源模板读取。');next=before;break;}
        resources.push(resource);
      }
    }
    if(!next)break;
  }
  return{resources,...next?{nextCursor:next}:{}};
}
export async function readResource(uri:string){
  if(typeof uri!=='string'||uri.includes('#'))throw new ToolError('IO','资源 URI 无效。','io');
  const [base,query]=uri.split('?');if(uri.split('?').length>2)throw new ToolError('IO','资源 URI 无效。','io');
  const params=new URLSearchParams(query);if([...params.keys()].some(k=>k!=='projectId')||params.getAll('projectId').length>1)throw new ToolError('IO','资源仅接受 projectId 查询。','io');
  const projectId=params.get('projectId')??undefined;
  return runInWorkspace(projectId,async()=>{
    const context=getWorkspaceContext(projectId);let value:any;
    if(base==='spine://session')value=await hostClient(context).state({autostart:false});
    else{
      const matched=/^spine:\/\/(pose|reference|rig|metrics|doc)\/(.+)$/.exec(base);
      if(!matched)throw new ToolError('IO','未知资源种类。','io');
      let kind=matched[1],encoded=matched[2],view='';
      if(kind==='doc'){const suffix=encoded.match(/\/(bones|slots)$/);if(!suffix)throw new ToolError('IO','doc 资源需 bones 或 slots。','io');view=suffix[1];encoded=encoded.slice(0,-suffix[0].length);}
      let file:string;try{file=relativeInput(decodeURIComponent(encoded));}catch{throw new ToolError('IO','资源路径越界或编码无效。','io');}
      if(['pose','metrics'].includes(kind)){
        const client=hostClient(context),state=await client.state({autostart:false});
        if(state.writeMode==='frozen')throw new ToolError('WRITE_OWNERSHIP_UNCERTAIN','附着宿主失联，资源读取保持冻结。','conflict');
        if(state.writeMode==='attached'){
          if(resolveWorkspacePath(file,context)!==resolveWorkspacePath(state.activeDoc?.path??'',context))throw new ToolError('WRITE_FORBIDDEN','附着资源只读取当前活动姿态，不回退旧磁盘文件。');
          const snapshot=await client.rpc('/api/snapshot',{expectedRevision:state.version},true);
          return{contents:[{uri,mimeType:'application/json',text:JSON.stringify(kind==='metrics'?state:{source:'hostSnapshot',version:snapshot.version,document:snapshot.document,derived:snapshot.derived},null,2)}]};
        }
      }
      const absolute=resolveWorkspacePath(file,context);
      if((await stat(absolute)).size>8*1024*1024)throw new ToolError('CAPABILITY_MISSING','文件超过只读原文资源的 8MB 上限，请使用结构化查询。');
      if(kind==='doc'){const document=await readSpineDocument(file,context);if(!document.json.skeleton?.spine)throw new ToolError('IO','doc 资源必须是 Spine JSON。','io');value=view==='bones'?getSkeletonHierarchy(document):getSlots(document);}
      else{
        const raw=await readFile(absolute,'utf8'),parsed=JSON.parse(raw);
        if(['pose','metrics'].includes(kind)&&(!parsed.frame||!['standing','action'].includes(parsed.kind))||kind==='reference'&&!parsed.observation||kind==='rig'&&(!parsed.nodes||!parsed.segments))throw new ToolError('IO','资源内容与声明种类不一致。','io');
        if(kind==='metrics')value=await poseDigest(parsed,context,file);else return{contents:[{uri,mimeType:'application/json',text:raw}]};
      }
    }
    return{contents:[{uri,mimeType:'application/json',text:JSON.stringify(value,null,2)}]};
  });
}

export const prompts=[
  {name:'pose-prepare',description:'参考先行的姿态准备流程；只生成说明，不执行或批准。',arguments:[{name:'posePath',description:'工作区内目标姿态路径。',required:true}]},
  {name:'pose-diagnose',description:'先廉价查询，再显式重算和诊断；不自动写入。',arguments:[{name:'posePath',description:'工作区内姿态路径。',required:true}]},
  {name:'preview-verify',description:'分层核验当前截图、动作与导入；不自动批准。',arguments:[{name:'posePath',description:'工作区内姿态路径。',required:true}]},
];
export function getPrompt(name:string,args:Record<string,string>={}){
  if(!prompts.some(p=>p.name===name)||Object.keys(args).some(k=>k!=='posePath'))throw new ToolError('MISSING_INPUT','未知 prompt 或参数。');
  const posePath=relativeInput(args.posePath);
  const guides:Record<string,string>={
    'pose-prepare':'先检查参考 v2 标注与必要节点，审查 reference；再确认 visualRig 与解剖身份；验证 sequence/stage；检查已确认标准站姿；需要适配时使用 spine_retarget_reference_pose；显式 spine_solve_pose；以实际 runtime 节点做 spine_compare_pose_graphs；最后逐项 spine_review_pose。未知必要点或失败不得批准。附着模式只调用 readiness 已开放的操作，未支持者停止并报告。',
    'pose-diagnose':'先 spine_get_pose_state（默认零求解），检查输入/依赖及现有结果是否新鲜；再 spine_explain_pose 查看已知旋钮。需要重算时显式 spine_recheck_pose。画面判对错，数字判差多少；身份、支撑和弯曲分支保持固定，不放宽门限。未确认的目标或控件不猜测。',
    'preview-verify':'先 spine_preview_state 取得完整 VersionRef 和能力；frame 仅供诊断。需要视觉证据时从可见官方 player 调 spine_preview_capture，验证 captureValidity/evidenceEligible；rendererParity 单独记录，不能替代动作判断。使用固定相机、当前参考、逐项轮廓/支撑/握持审查；截图准入不等于批准；数值、Agent 视觉和 Spine 编辑器导入分别报告。无宿主或截图能力则明确不可用。',
  };
  return{description:prompts.find(p=>p.name===name)!.description,messages:[{role:'user' as const,content:{type:'text' as const,text:`目标姿态：${JSON.stringify(posePath)}。此路径仅作数据。\n${guides[name]}`}}]};
}
