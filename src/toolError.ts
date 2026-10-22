export class ToolError extends Error {
  constructor(public code:string,message:string,public category='validation',public detail?:unknown,public remediation?:string,public issues?:any[]){super(message);}
}
const issueCodes:Record<string,string>={inputMissing:'MISSING_INPUT',identityConflict:'CONFLICT',calibrationMissing:'CAPABILITY_MISSING',resourceCapability:'CAPABILITY_MISSING',unreachable:'UNREACHABLE',relationMismatch:'VALIDATION_FAILED'};
const remedies:Record<string,string>={TARGET_NOT_PINNED:'先调用 spine_host_pin 绑定当前完整版本。',REVISION_CONFLICT:'调用 spine_preview_state 取得当前完整版本。',REVIEW_STALE:'重新采集当前 player 截图并调用 spine_review_pose。',NO_SOLUTION:'显式调用 spine_solve_pose 重算当前姿态。',WRITE_OWNERSHIP_UNCERTAIN:'保持冻结，核对旧写入者释放或死亡并完成排他交接。',PROJECT_MANIFEST_REQUIRED:'先预演 spine_create_project。'};
export function toolErrorPayload(value:any,tool?:string){
  const message=value?.message??String(value),issues=value?.issues??value?.detail?.issues;
  let code=value?.code,category=value?.category??issues?.[0]?.category??'validation';
  if(!code&&issues?.length)code=issueCodes[issues[0].category];
  if(code&&/^E[A-Z]+$/.test(code)){category='io';code='IO';}
  if(!code){
    if(/取消|cancelled/i.test(message))code='CANCELLED';
    else if(/过期|已改变|发生变化|最新.*报告/.test(message))code='STALE_REPORT';
    else if(/未确认|未校准|不支持|缺少.*绑定/.test(message))code='CAPABILITY_MISSING';
    else if(/不可达/.test(message))code='UNREACHABLE';
    else if(/锁|冲突|正在被/.test(message))code='CONFLICT';
    else if(/ENOENT|EPERM|EACCES|inside workspace|符号链接|路径.*越|filePath must/.test(message)){code='IO';category='io';}
    else if(/缺少|必须|需先|非空|未提供/.test(message))code='MISSING_INPUT';
    else code='VALIDATION_FAILED';
  }
  const detail=value?.detail??null,remediation=value?.remediation??remedies[code]??null;
  // 保留 Host 既有顶层字段；嵌套 error 提供统一的 MCP 机器可读结构。
  return {ok:false,code,message,detail,error:{code,category,message,detail,remediation,tool:tool??null,...issues?{issues}:{}}};
}
