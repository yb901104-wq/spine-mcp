import { motionIntervalOpsSchema } from './motionInterval.js';
import { hostClient } from './hostClient.js';
import type { ToolContext } from './spineJson.js';
import { HostError } from './hostContracts.js';
import { c2PosePatchOpsSchema } from './hostPosePatch.js';
export const versionSchema={type:'object',additionalProperties:false,properties:{sessionId:{type:'string'},documentId:{type:'string'},openEpoch:{type:'string'},revision:{type:'integer',minimum:0}},required:['sessionId','documentId','openEpoch','revision']};
const version={expectedRevision:versionSchema},dryRun={dryRun:{type:'boolean',default:true,description:'默认只预演；false 才改变内存/历史或请求真实提交。'}},file={type:'string',description:'工作区内相对路径。'};
const animation={anyOf:[{type:'string',minLength:1},{type:'null'}],description:'隔离 C2 动画选择；null 仅表示 skeleton setup。打开时须同时给 time，不能自动猜动画。'};
const definition=(name:string,description:string,properties:Record<string,any>,required:string[]=[])=>({name,description,inputSchema:{type:'object',additionalProperties:false,properties:{projectId:{type:'string'},...properties},required}});
export const hostToolDefinitions=[
  definition('spine_resume_diagnostic_pose','显式恢复独立诊断草稿；默认 dryRun 先列来源、哈希和差异。仅隔离 C2 Host，已有活动文档时必须完整版本。实际恢复采用新 openEpoch，清除旧求解、截图准入、pin 和批准；失败仍不能保存为正式资产。',{diagnosticId:{type:'string',pattern:'^[a-f0-9]{64}$'},...version,...dryRun},['diagnosticId']),
  definition('spine_host_open','显式打开工程及文档；隔离 C2 可成对选择 animation/time，改变选择产生新 openEpoch。默认不求解；recheck:true 由 MCP 显式计算并返回当前图，不写源资产。切换/重载须完整版本。',{manifestPath:file,path:file,reload:{type:'boolean',default:false},animation,time:{type:'number',minimum:0,description:'动画内时间（秒），不循环取模。'},recheck:{type:'boolean',default:false,description:'显式重算并发布当前选择的观察候选，返回 PNG；不批准或提交。'},...version}),
  definition('spine_preview_state','只读查询工程、活动文档、完整版本、实际能力和 readiness；不隐式求解。',{includeCapabilities:{type:'boolean',default:true}}),
  definition('spine_preview_frame','按完整版本读取实际回放 PNG。variant:previous 仅返回同文档/相机已缓存的前次 480 诊断图，独立标记旧版本、不可作批准证据；不跨文档复用。当前帧显式选择须一致，读取不能切换动画。',{...version,variant:{type:'string',enum:['current','previous'],default:'current'},animation,size:{type:'integer',enum:[320,480],default:480},time:{type:'number',minimum:0}},['expectedRevision']),
  definition('spine_preview_capture','请求可见的真实官方 player 页面按当前 pose 或隔离 C2 动画/时间截图。后台/超时拒绝，显式选择须与活动版本一致；截图准入不等于视觉批准。',{...version,animation,size:{type:'integer',enum:[320,480,960],default:960},time:{type:'number',minimum:0},viewport:{type:'object',additionalProperties:false,properties:{width:{type:'integer',minimum:1},height:{type:'integer',minimum:1}},required:['width','height']}},['expectedRevision']),
  definition('spine_host_pin','绑定完整身份及磁盘基线。普通 pin 用于 pose 编辑及隔离 C2 motion 区间/草稿修订；intent:asset 绑定资产创建来源，intent:animation 另行绑定 motion 的角色源动画提交。普通 pin 不授予源动画提交资格。',{...version,intent:{type:'string',enum:['asset','animation'],description:'隔离 C2 的独立资产或源动画提交意图；仍须全部审查及授权。'}},['expectedRevision']),
  definition('spine_host_patch','按宿主 capabilities.editing 预演或编辑内存文档，默认 dryRun。生产 C1 仅一个手目标；隔离 C2 pose 支持声明参数原子批次，motion 只允许单个受控区间操作，两类不可混用。固定绑定/支撑不修改，真实修改后由 MCP 重算并返回新图。',{...version,...dryRun,ops:{oneOf:[c2PosePatchOpsSchema,motionIntervalOpsSchema]}},['expectedRevision','ops']),
  definition('spine_host_commit','预演精确候选，MCP 验证并授权后由 Host 备份及原子发布。draft 保存 pose 或隔离 C2 motion 新修订；asset 保存暂存的新 pose/motion；animation 在完整动画批准及当前 player 证据通过后，仅替换角色源的单个动画。保存资产不切换文档；源动画提交使当前 motion 产生新 revision。',{...version,...dryRun,outputPath:file,intent:{type:'string',enum:['draft','asset','animation'],default:'draft'},assetCandidateHash:{type:'string',description:'intent:asset 必填暂存结果的精确 candidateHash。'},animationCandidateHash:{type:'string',description:'intent:animation 必填已审查拟合候选的精确字节哈希。'},expectedHash:{type:'string',description:'intent:animation 必填角色源文件的预期 SHA-256。'},reviewToken:{type:'string',description:'intent:animation 必填完整动画视觉批准令牌。'},requestId:{type:'string',minLength:1,maxLength:128,description:'真实提交必填且重试必须复用。响应丢失时返回同一回执。'}},['expectedRevision','outputPath']),
  ...(['undo','redo']as const).map(direction=>definition(`spine_host_${direction}`,`对未提交修改执行 ${direction}；产生新 revision，清除旧结果与批准，默认 dryRun。`,{...version,...dryRun},['expectedRevision'])),
];
export async function callHostTool(name:string,args:any,context:ToolContext,signal?:AbortSignal,progress?:(stage:string)=>void){
  const client=hostClient(context),{projectId:_projectId,...input}=args;
  switch(name){
    case'spine_resume_diagnostic_pose':return client.resumeDiagnostic(input,signal,progress);
    case'spine_host_open':return client.open(input,signal,progress);
    case'spine_preview_state':return client.state(input);
    case'spine_preview_frame':return client.frame(input);
    case'spine_preview_capture':return client.capture(input);
    case'spine_host_pin':if(!await client.ensurePreview())throw new HostError('WRITE_FORBIDDEN','镜像模式不能 pin 写入目标。',409);return client.rpc('/api/pin',input);
    case'spine_host_patch':return client.patch(input,signal,progress);
    case'spine_host_commit':return client.commit(input);
    case'spine_host_undo':return client.history('undo',input,signal,progress);
    case'spine_host_redo':return client.history('redo',input,signal,progress);
    default:throw new Error(`未知 Host 操作 ${name}。`);
  }
}
