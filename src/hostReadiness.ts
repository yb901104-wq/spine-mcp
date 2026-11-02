import { isDiagnosticPerspective } from './perspective.js';
import type { HostDocument } from './hostDocumentStore.js';

const handRoles = ['leftHand', 'rightHand'] as const;
const finitePoint = (value: unknown): value is number[] => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);

/** 只描述当前声明和前置条件；不求解、不校准、不签发批准或授权。 */
export function handTargetCapabilities(doc: HostDocument | null) {
  return handRoles.map(role => {
    const anchor = doc?.mapping?.bones?.anchors?.[role];
    const supported = !!doc?.value.frame?.targets?.[role] && typeof anchor?.bone === 'string' && finitePoint(anchor.point);
    const controlledFields = doc?.value.weapon ? ['x', 'y'] : [];
    return { role, supported, controlledFields, availableFields: supported ? (doc?.value.weapon ? ['angle'] : ['x', 'y', 'angle']) : [],
      gripPoint: { status: finitePoint(anchor?.gripPoint) ? 'present' : 'missing', required: !!doc?.value.weapon },
      source: { path: doc?.value.mappingPath ?? null, field: `bones.anchors.${role}`, verification: 'unknown' },
      coordinateSystem: 'normalizedSkeleton', angleUnit: 'degree' };
  });
}

export function hostOperationReadiness(input: {
  doc: HostDocument | null; mode: 'host' | 'mirror'; writeMode: string; managed: boolean;
  pinned: boolean; stale: boolean; frozen: boolean; pendingOperations: number; checked: 'fast' | 'strict';
  evaluationTasks?: Array<{ status: string }>;
  extendedPoseTargets?: Array<{ supported: boolean }>; poseParametersAvailable?: boolean;
  animationViewing?: boolean;motionEditing?:boolean;
}) {
  const { doc, mode, writeMode, managed, pinned, stale, frozen, pendingOperations, checked } = input;
  const targets = handTargetCapabilities(doc);
  const writes = ['patch', 'undo', 'redo', 'commit', 'review'];
  const serial = ['open', 'evaluate', ...writes];
  const evaluateTool = doc && doc.kind !== 'pose' ? 'spine_host_open' : 'spine_recheck_pose';
  const tools: Record<string, string | null> = { open: 'spine_host_open', inspect: null, evaluate: evaluateTool,
    frame: 'spine_preview_frame', capture: 'spine_preview_capture', review: 'spine_review_pose', patch: 'spine_host_patch',
    undo: 'spine_host_undo', redo: 'spine_host_redo', commit: 'spine_host_commit' };
  return Object.keys(tools).map(operation => {
    const needsPose = !['open', 'inspect'].includes(operation);
    const needsHost = ['evaluate', 'capture', ...writes].includes(operation);
    const supported = (!needsPose || !doc || doc.kind === 'pose' || input.motionEditing&&['patch','undo','redo','commit'].includes(operation) || input.animationViewing && ['evaluate','frame','capture'].includes(operation)) && (!needsHost || mode === 'host') && (!writes.includes(operation) || writeMode === 'attached' || frozen);
    let state = 'ready', code = '', message = '', path: string | undefined, nextTool: string | null = null;
    const block = (nextState: string, nextCode: string, nextMessage: string) => { state = nextState; code = nextCode; message = nextMessage; };
    if (operation !== 'open' && !doc) block('blocked', 'DOC_NOT_LOADED', '请先显式打开文档；查询不会自动选择或求解。');
    else if (!supported) block('unsupported', writes.includes(operation) && writeMode !== 'attached' ? 'WRITE_FORBIDDEN' : 'CAPABILITY_MISSING', '当前 mode/kind 未开放该操作；不自动回退或扩大 C1 白名单。');
    else if (writes.includes(operation) && frozen) block('frozen', 'WRITE_OWNERSHIP_UNCERTAIN', '排他写入权尚未确认；只按已确认交接或死亡恢复流程处理。');
    else if (operation !== 'open' && stale) block('stale', 'TARGET_STALE', '当前文件或依赖已变化；保留草稿并显式处理重载。');
    else if (doc?.kind !== 'pose' && ['evaluate','frame','capture'].includes(operation) && !doc?.view) block('blocked', 'VIEW_NOT_SELECTED', '用 spine_host_open 显式选择 animation/time，需要重算时 recheck:true。');
    else if (serial.includes(operation) && input.evaluationTasks?.length) block('busy',
      input.evaluationTasks.some(task => task.status === 'unresponsive') ? 'EVALUATION_UNRESPONSIVE' : 'EVALUATION_BUSY',
      input.evaluationTasks.some(task => task.status === 'unresponsive') ? '当前版本的外部求解心跳失联；结束状态未知，核对任务或显式重载，不能自动宣称已完成。' : 'MCP 正在计算当前文档版本；等待完成后重新查询，旧版本任务不影响新文档。');
    else if (serial.includes(operation) && pendingOperations > 0) block('busy', 'HOST_BUSY', 'Host 串行事务正在执行或排队；等待完成后重新查询。');
    else if (writes.includes(operation) && !managed) block('blocked', 'PROJECT_MANIFEST_REQUIRED', '编辑前必须初始化并打开受管工程。');
    else if (['patch', 'undo', 'redo', 'commit'].includes(operation) && !pinned) {
      block('blocked', 'TARGET_NOT_PINNED', '先绑定当前活动文档的完整身份与磁盘基线。'); nextTool = 'spine_host_pin';
    } else if (['evaluate', 'patch'].includes(operation) && doc?.value.weapon && targets.some(target => target.gripPoint.status === 'missing')) {
      const missing = targets.find(target => target.gripPoint.status === 'missing')!;
      block('blocked', 'CAPABILITY_MISSING', '持杖姿态缺少所需的手部 gripPoint；先按实际切片补齐并审查绑定。');
      path = `${doc.value.mappingPath}#/bones/anchors/${missing.role}/gripPoint`;
    } else if (operation === 'patch' && !input.motionEditing && !(input.extendedPoseTargets ?? targets).some(target => target.supported) && !input.poseParametersAvailable) block('blocked', 'CAPABILITY_MISSING', '没有可用姿态参数或既有目标及有效末端锚点；不能猜测绑定。');
    else if (['frame', 'capture', 'review', 'commit'].includes(operation) && !doc?.derived) {
      block('blocked', 'NO_SOLUTION', doc?.kind === 'pose' ? '没有当前可信的求解结果；请显式重算。' : '没有当前动画/时间的可信候选；用 spine_host_open recheck:true 显式重算。'); nextTool = mode === 'host' ? evaluateTool : null;
    } else if(operation==='review'&&isDiagnosticPerspective(doc?.value.frame))block('blocked','DIAGNOSTIC_ONLY','透视缩放当前仅诊断，不能批准为正式姿态。');
    else if (operation === 'capture') block('blocked', doc?.derived?.live ? 'CAPTURE_TIMEOUT' : 'NO_SOLUTION', doc?.derived?.live ? '需要可见且上报当前心跳的官方 player 页面。' : '需要显式发布当前不可变 player 候选。');
    else if (operation === 'review') block('blocked', 'CAPTURE_UNVERIFIED', '需要当前 Host 核验并登记的 player 证据；准入不等于批准。');
    else if (operation === 'commit') block('blocked', 'COMMIT_NOT_AUTHORIZED', '先预演明确输出路径的精确候选，再由 MCP 复验并签发一次性授权。');
    return { operation, supported, schemaId: tools[operation] ?? 'host.inspect', schemaVersion: 1, checked, observedAt: new Date().toISOString(),
      state, canRun: state === 'ready', reasons: code ? [{ code, message, ...(path ? { path } : {}) }] : [],
      nextAction: state === 'ready' ? null : { tool: nextTool, instruction: message } };
  });
}
