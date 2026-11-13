import { HostError } from './hostContracts.js';

interface ProjectHost { shutdownForSwitch(): Promise<void> }
/** 单个 MCP 连接的工程切换串行化；只读探测不调用此协调器。 */
export class HostLifecycle {
  private active: ProjectHost | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  activate<T extends ProjectHost>(client: T, connect: () => Promise<boolean>): Promise<boolean> {
    const operation = this.queue.then(async () => {
      if (this.active && this.active !== client) {
        try { await this.active.shutdownForSwitch(); }
        catch (error) { throw new HostError('WRITE_OWNERSHIP_UNCERTAIN', '旧工程 Host 未确认关闭并释放写入权，禁止启动新工程。', 409, { cause: String(error) }); }
        this.active = null;
      }
      const connected = await connect();
      if (connected) this.active = client;
      return connected;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
export const hostLifecycle = new HostLifecycle();
