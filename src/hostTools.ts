import { hostClient } from './hostClient.js';
import type { ToolContext } from './spineJson.js';
import { HostError } from './hostContracts.js';
export const versionSchema={type:'object',additionalProperties:false,properties:{sessionId:{type:'string'},documentId:{type:'string'},openEpoch:{type:'string'},revision:{type:'integer',minimum:0}},required:['sessionId','documentId','openEpoch','revision']};
const version={expectedRevision:versionSchema},dryRun={dryRun:{type:'boolean',default:true,description:'默认只预演；false 才改变内存/历史或请求真实提交。'}},file={type:'string',description:'工作区内相对路径。'};
const definition=(name:string,description:string,properties:Record<string,any>,required:string[]=[])=>({name,description,inputSchema:{type:'object',additionalProperties:false,properties:{projectId:{type:'string'},...properties},required}});
export const hostToolDefinitions=[
  definition('spine_host_open','显式打开工程及可选文档；没有宿主时建立 MCP 镜像。切换/重载须带当前完整版本，清除旧 pin 和授权。',{manifestPath:file,path:file,reload:{type:'boolean',default:false},...version}),
  definition('spine_preview_state','只读查询工程、活动文档、完整版本、实际能力和 readiness；不隐式求解。',{includeCapabilities:{type:'boolean',default:true}}),
  definition('spine_preview_frame','按完整版本读取当前 pose 的实际 canvas 回放图，返回 PNG。镜像读取磁盘结果；无结果或过期时拒绝。',{...version,size:{type:'integer',enum:[320,480],default:480},time:{type:'number',minimum:0}},['expectedRevision']),
  definition('spine_preview_capture','请求可见的真实官方 player 页面摆帧截图。后台/超时拒绝；独立记录 rendererParity、captureValidity 与 evidenceEligible，准入不等于视觉批准。',{...version,size:{type:'integer',enum:[320,480,960],default:960},time:{type:'number',minimum:0},viewport:{type:'object',additionalProperties:false,properties:{width:{type:'integer',minimum:1},height:{type:'integer',minimum:1}},required:['width','height']}},['expectedRevision']),
  definition('spine_host_pin','绑定活动文档的完整身份与磁盘基线；不批准内容，也不授予写入权。',{...version},['expectedRevision']),
  definition('spine_host_patch','预演或编辑内存姿态。C1 一次仅允许一个手目标 x/y/angle，真实修改后由 MCP 重算并返回新图；默认 dryRun。',{...version,...dryRun,ops:{type:'array',minItems:1,maxItems:1,items:{type:'object',additionalProperties:false,properties:{op:{const:'setPoseTarget'},path:{type:'string',enum:['pose/frame/targets/leftHand','pose/frame/targets/rightHand']},role:{type:'string',enum:['leftHand','rightHand']},x:{type:'number',description:'normalizedSkeleton 横坐标，禁止图片像素。'},y:{type:'number',description:'normalizedSkeleton 纵坐标，禁止图片像素。'},angle:{type:'number',minimum:-180,exclusiveMaximum:180,description:'期望世界方向，单位度。'}},required:['op','path','role'],anyOf:[{required:['x']},{required:['y']},{required:['angle']}]}}},['expectedRevision','ops']),
  definition('spine_host_commit','预演精确候选；真实保存由 MCP 验证候选并登记一次性授权，Host 备份后原子创建 pose 新修订。C1 不接受动画提交。',{...version,...dryRun,outputPath:file,intent:{type:'string',enum:['draft'],default:'draft'},requestId:{type:'string',minLength:1,maxLength:128,description:'真实提交必填且重试必须复用。响应丢失时返回同一回执。'}},['expectedRevision','outputPath']),
  ...(['undo','redo']as const).map(direction=>definition(`spine_host_${direction}`,`对未提交修改执行 ${direction}；产生新 revision，清除旧结果与批准，默认 dryRun。`,{...version,...dryRun},['expectedRevision'])),
];
export async function callHostTool(name:string,args:any,context:ToolContext,signal?:AbortSignal,progress?:(stage:string)=>void){
  const client=hostClient(context),{projectId:_projectId,...input}=args;
  switch(name){
    case'spine_host_open':return client.open(input);
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
