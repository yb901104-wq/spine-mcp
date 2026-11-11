import { HostError } from './hostContracts.js';
export const toolGroups={project:'工程与工作区',observe:'观察与预览',reference:'参考与绑定',pose:'姿态编辑',animation:'连续动画',review:'审查、校验与恢复',workflow:'创作任务',discovery:'工具目录'};
export type ToolGroup=keyof typeof toolGroups;
const core:ToolGroup[]=['project','observe','workflow','discovery'];
export function toolGroup(name:string):ToolGroup{
  if(['spine_get_tool_catalog','spine_set_tool_groups'].includes(name))return 'discovery';
  if(name==='spine_execute_task')return 'workflow';
  if(/creation_task|creation_stage/.test(name))return 'workflow';
  if(name==='spine_check_editor_import')return 'review';
  if(/workspace|project|agent_/.test(name))return 'project';
  if(/review|validate|official_spec|backup|restore/.test(name))return 'review';
  if(name==='spine_create_pose_sequence')return 'reference';
  if(/reference|visual_rig|mapping|pose_graph|arm_perspective/.test(name))return 'reference';
  if(/motion|animation|keyframe|curve|loop/.test(name)&&!/render|preview/.test(name))return 'animation';
  if(/pose|host_(patch|pin|commit|undo|redo)/.test(name))return 'pose';
  return 'observe';
}
const groups={type:'array',uniqueItems:true,items:{type:'string',enum:Object.keys(toolGroups)}};
export const catalogToolDefinitions=[
  {name:'spine_get_tool_catalog',description:'按工程、观察、参考、姿态、动画和审查列出实际工具名称；只读，不把工具可见性当成写入权限。',inputSchema:{type:'object',additionalProperties:false,properties:{projectId:{type:'string'},group:{type:'string',enum:Object.keys(toolGroups)}}}},
  {name:'spine_set_tool_groups',description:'仅显式启用动态发现的 MCP 连接可改变工具组；默认 dryRun。核心入口保留，静态客户端继续使用完整列表，不修改工程或写入权限。',inputSchema:{type:'object',additionalProperties:false,properties:{projectId:{type:'string'},groups,dryRun:{type:'boolean',default:true}},required:['groups']}}
];
export class ToolCatalog{
  private enabled=new Set<ToolGroup>(core);
  constructor(private readonly definitions:any[],readonly dynamic=process.env.SPINE_MCP_TOOL_DISCOVERY==='dynamic'){}
  list(){return this.definitions.filter(t=>!this.dynamic||this.enabled.has(toolGroup(t.name)));}
  has(name:string){return this.list().some(t=>t.name===name);}
  projectActions(value:any,depth=0):any{
    if(!value||typeof value!=='object'||depth>8)return value;
    if(Array.isArray(value))return value.map(v=>this.projectActions(v,depth+1));
    if(typeof value.tool==='string'&&!this.has(value.tool))return {tool:'spine_get_tool_catalog',arguments:{group:toolGroup(value.tool)},instruction:'所需工具当前未在本连接启用；先查询目录，不把可见性当成写入授权。'};
    const result={...value};
    // 只投影动作容器，不遍历顶点、完整角色或其它数值负载。
    for(const key of ['nextAction','nextActions','examples','state','creationQuality','reference','failures','stageContexts','diagnosticContexts','candidates'])if(result[key])result[key]=this.projectActions(result[key],depth+1);
    return result;
  }
  describe(group?:ToolGroup){return {mode:this.dynamic?'dynamic':'static',groups:Object.entries(toolGroups).filter(([key])=>!group||group===key).map(([id,name])=>({id,name,enabled:!this.dynamic||this.enabled.has(id as ToolGroup),tools:this.definitions.filter(t=>toolGroup(t.name)===id).map(t=>({name:t.name,description:t.description}))})),note:'目录不授予写入权限；动态模式需在目标客户端实测 list_changed 及重新发现。'};}
  select(args:any){
    if(!Array.isArray(args.groups)||args.groups.some((g:any)=>!Object.hasOwn(toolGroups,g)))throw new HostError('INVALID_ARGUMENT','工具组无效。');
    if(!this.dynamic)throw new HostError('CAPABILITY_MISSING','当前是静态完整目录；动态发现须启动时显式设置 SPINE_MCP_TOOL_DISCOVERY=dynamic，并验证目标客户端。',409);
    const selected=[...new Set([...core,...args.groups])]as ToolGroup[];
    if(args.dryRun===false)this.enabled=new Set(selected);
    return {ok:true,dryRun:args.dryRun!==false,groups:selected,permissionChanged:false};
  }
}
