import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { assertVersion, HostError, objectHash, type VersionRef } from './hostContracts.js';

export const EVALUATION_TASK_TTL_MS = 15000;
type Stage = 'snapshot' | 'solve' | 'publish';
type Outcome = 'succeeded' | 'failed' | 'cancelled';
interface Task { taskId: string; leaseKey: string; version: VersionRef; stage: Stage; startedAt: number; lastSeenAt: number; outcome?: Outcome }
const validIdentity = (taskId: unknown, leaseKey: unknown) => typeof taskId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(taskId) && typeof leaseKey === 'string' && /^[a-f0-9]{64}$/.test(leaseKey);

/** 任务观察租约不等于 Writer、文档锁或提交授权。失去心跳不自动推断进程已结束。 */
export class HostEvaluationTasks {
  private active = new Map<string, Task>();
  private recent = new Map<string, Task>();
  constructor(private readonly now = () => Date.now()) {}
  private owned(taskId: string, leaseKey: string) {
    if (!validIdentity(taskId, leaseKey)) throw new HostError('INVALID_ARGUMENT', '任务 ID 或观察租约格式无效。');
    const task = this.active.get(taskId) ?? this.recent.get(taskId);
    if (!task || !timingSafeEqual(Buffer.from(task.leaseKey), Buffer.from(leaseKey))) throw new HostError('TASK_NOT_FOUND', '任务不存在或不属于当前观察租约。', 409);
    return task;
  }
  begin(taskId: string, leaseKey: string, version: VersionRef) {
    if (!validIdentity(taskId, leaseKey)) throw new HostError('INVALID_ARGUMENT', '任务 ID 或观察租约格式无效。');
    if (this.active.has(taskId) || this.recent.has(taskId)) {
      const task = this.owned(taskId, leaseKey); assertVersion(version, task.version);
      return { ok: true, taskId, replayed: true, terminal: !!task.outcome };
    }
    // 旧版本的计算无法发布到新版本，不占用当前版本的观察容量。
    for (const [id, task] of this.active) if (objectHash(task.version) !== objectHash(version)) this.active.delete(id);
    if (this.active.size >= 16) throw new HostError('HOST_BUSY', '同一文档版本最多登记 16 个外部求解任务。', 409);
    const now = this.now();
    this.active.set(taskId, { taskId, leaseKey, version: structuredClone(version), stage: 'snapshot', startedAt: now, lastSeenAt: now });
    return { ok: true, taskId, replayed: false, terminal: false };
  }
  heartbeat(taskId: string, leaseKey: string, stage: Stage) {
    if (!['snapshot', 'solve', 'publish'].includes(stage)) throw new HostError('INVALID_ARGUMENT', '任务阶段只能是 snapshot、solve 或 publish。');
    const task = this.owned(taskId, leaseKey);
    if (task.outcome) throw new HostError('TASK_FINISHED', '任务已有终态，不能重新续期。', 409);
    if (this.now() - task.lastSeenAt >= EVALUATION_TASK_TTL_MS) throw new HostError('TASK_LEASE_EXPIRED', '求解心跳已过期；先核对状态，不自动恢复 ready。', 409);
    task.stage = stage; task.lastSeenAt = this.now(); return { ok: true, taskId };
  }
  finish(taskId: string, leaseKey: string, outcome: Outcome, stage?: Stage) {
    if (!['succeeded', 'failed', 'cancelled'].includes(outcome)) throw new HostError('INVALID_ARGUMENT', '任务终态只能是 succeeded、failed 或 cancelled。');
    if (stage !== undefined && !['snapshot', 'solve', 'publish'].includes(stage)) throw new HostError('INVALID_ARGUMENT', '任务阶段只能是 snapshot、solve 或 publish。');
    const task = this.owned(taskId, leaseKey);
    if (task.outcome && task.outcome !== outcome) throw new HostError('TASK_CONFLICT', '任务已有不同终态，不能覆盖。', 409);
    if (!task.outcome && stage !== undefined) task.stage = stage;
    task.outcome = outcome; this.active.delete(taskId); this.recent.set(taskId, task);
    while (this.recent.size > 32) this.recent.delete(this.recent.keys().next().value!);
    return { ok: true, taskId, outcome };
  }
  state(version: VersionRef | null) {
    const same = (task: Task) => version !== null && objectHash(task.version) === objectHash(version);
    const summary = (task: Task) => ({ taskId: task.taskId, version: structuredClone(task.version), stage: task.stage,
      status: task.outcome ?? (this.now() - task.lastSeenAt >= EVALUATION_TASK_TTL_MS ? 'unresponsive' : 'running'),
      startedAt: new Date(task.startedAt).toISOString(), lastHeartbeatAt: new Date(task.lastSeenAt).toISOString(),
      leaseExpiresAt: new Date(task.lastSeenAt + EVALUATION_TASK_TTL_MS).toISOString() });
    return { active: [...this.active.values()].filter(same).map(summary), recent: [...this.recent.values()].filter(same).slice(-4).map(summary) };
  }
}

/** 所有结束路径都独立回报终态；取消信号不能取消清理。 */
export async function withHostEvaluationTask<T>(
  rpc: (args: any, signal?: AbortSignal) => Promise<any>, version: VersionRef, signal: AbortSignal | undefined,
  work: (task: { stage: (value: Stage) => void; check: () => void }) => Promise<T>,
) {
  const cancelled = () => { if (signal?.aborted) throw new HostError('TASK_CANCELLED', '求解已取消；已确认的编辑和派生事务不回滚。', 409); };
  cancelled();
  const taskId = randomUUID(), leaseKey = randomBytes(32).toString('hex');
  const identity = { taskId, leaseKey };
  let stage: Stage = 'snapshot', outcome: Outcome = 'failed', heartbeatError: unknown;
  let heartbeat: Promise<void> | undefined, timer: ReturnType<typeof setInterval> | undefined, completed = false;
  const check = () => { cancelled(); if (heartbeatError) throw heartbeatError; };
  try {
    // ID/租约在调用前已知；即使 begin 回执丢失，finally 仍可尝试结束该任务。
    const begun = await rpc({ action: 'begin', expectedRevision: version, ...identity }, signal);
    if (begun.terminal) throw new HostError('TASK_FINISHED', '不能复用已有终态的任务 ID。', 409);
    check();
    timer = setInterval(() => {
      if (heartbeat) return;
      heartbeat = rpc({ action: 'heartbeat', stage, ...identity }).then(() => undefined).catch(error => { heartbeatError = error; }).finally(() => { heartbeat = undefined; });
    }, 5000); timer.unref();
    const result = await work({ stage: value => { stage = value; }, check });
    completed = true; outcome = 'succeeded'; return result;
  } catch (error: any) { outcome = signal?.aborted || ['TASK_CANCELLED', 'CANCELLED'].includes(error.code) ? 'cancelled' : 'failed'; throw error; }
  finally {
    if (timer) clearInterval(timer);
    await heartbeat;
    try { await rpc({ action: 'finish', outcome, stage, ...identity }); }
    catch {
      if (completed) throw new HostError('TASK_STATUS_UNCERTAIN', '派生结果已发布，但求解任务终态回执未确认；请查询 Host，不能据此声称发布被回滚。', 409, { taskId, published: true });
      // 保留原始取消/失败；Host 的失联任务保持 unresponsive，不伪报已结束。
    }
  }
}
