/** 工程清单的公开 JSON schema 与运行时校验共用同一定义。 */
export interface ProjectManifest {
  format: 'spine-ai-workspace';
  schemaVersion: 1;
  projectId: string;
  name: string;
  characters: Record<string, {
    skeletonPath: string; atlasPath: string; mappingPath: string;
    visualRigPath?: string; skin?: string; spineVersion: string;
  }>;
  documents: Array<{
    path: string; kind: 'skeleton' | 'pose' | 'motion'; characterId: string;
    referencePosePath?: string; sequencePath?: string; stageId?: string; standardPosePath?: string;
  }>;
  references: { posePaths: string[]; sequencePaths: string[] };
  artifactRoots: { previews: string; reports: string };
  defaults?: { characterId?: string; documentPath?: string };
}

type Schema = {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean';
  properties?: Record<string, Schema>; required?: readonly string[];
  additionalProperties?: boolean | Schema; items?: Schema; minProperties?: number;
  pattern?: string; const?: unknown; enum?: readonly string[]; description?: string; default?: unknown;
};
const text = (description: string): Schema => ({ type: 'string', pattern: '\\S', description });
const file = text('相对工作区的资源路径；禁止绝对路径、上级目录和越界符号链接。');
const list: Schema = { type: 'array', items: file };
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({
  type: 'object', properties, required, additionalProperties: false,
});
export const projectManifestSchema = object({
  format: { type: 'string', const: 'spine-ai-workspace' },
  schemaVersion: { type: 'number', const: 1 },
  projectId: text('已登记工作区的稳定 projectId；初始化不会自动登记工作区。'),
  name: text('工程名称。'),
  characters: {
    type: 'object', minProperties: 1,
    additionalProperties: object({
      skeletonPath: file, atlasPath: file, mappingPath: file, visualRigPath: file,
      skin: { type: 'string', description: '已存在的皮肤名；空字符串表示默认皮肤。' },
      spineVersion: text('必须与 skeleton.spine 一致；动画写入仍只支持 4.1.24。'),
    }, ['skeletonPath', 'atlasPath', 'mappingPath', 'spineVersion']),
  },
  documents: {
    type: 'array', items: object({
      path: file, kind: { type: 'string', enum: ['skeleton', 'pose', 'motion'] },
      characterId: text('characters 中明确登记的角色 ID。'),
      referencePosePath: file, sequencePath: file, stageId: text('动作级阶段 ID。'), standardPosePath: file,
    }, ['path', 'kind', 'characterId']),
  },
  references: object({ posePaths: list, sequencePaths: list }),
  artifactRoots: object({ previews: file, reports: file }),
  defaults: object({ characterId: text('建议使用的角色 ID。'), documentPath: file }, []),
}, ['format', 'schemaVersion', 'projectId', 'name', 'characters', 'documents', 'references', 'artifactRoots']);

export const createProjectSchema = object({
  projectId: text('可选已登记工作区 projectId。'),
  manifest: projectManifestSchema,
  dryRun: { type: 'boolean', default: true, description: '默认只验证并返回候选；false 才初始化元数据。' },
  expectedAbsent: { type: 'boolean', const: true, description: '必须明确要求目标不存在；已有清单一律拒绝覆盖。' },
}, ['manifest', 'expectedAbsent']);

export class ProjectError extends Error {
  constructor(public readonly code: string, message: string) { super(`${code}: ${message}`); }
}

// 只支持本文件实际使用的 schema 子集；新增约束时必须同步扩展并测试。
export function checkProjectSchema(value: unknown, schema: Schema, label = 'manifest'): void {
  const fail = (reason: string): never => { throw new ProjectError('PROJECT_MANIFEST_INVALID', `${label} ${reason}`); };
  const objectValue = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (schema.type === 'object' ? !objectValue : schema.type === 'array' ? !Array.isArray(value) : typeof value !== schema.type) fail(`必须是 ${schema.type}。`);
  if ('const' in schema && value !== schema.const) fail(`必须为 ${JSON.stringify(schema.const)}。`);
  if (schema.enum && !schema.enum.includes(value as string)) fail(`必须为 ${schema.enum.join('、')} 之一。`);
  if (schema.pattern && !new RegExp(schema.pattern).test(value as string)) fail('不能为空白。');
  if (schema.type === 'object') {
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length < (schema.minProperties ?? 0)) fail('至少需要一个条目。');
    for (const key of schema.required ?? []) if (!Object.hasOwn(record, key)) fail(`缺少 ${key}。`);
    for (const [key, item] of Object.entries(record)) {
      const child = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties![key] : schema.additionalProperties;
      if (!child) fail(`包含未声明字段 ${key}。`);
      if (typeof child === 'object') checkProjectSchema(item, child, `${label}.${key}`);
    }
  }
  if (schema.type === 'array') for (const [i, item] of (value as unknown[]).entries()) checkProjectSchema(item, schema.items!, `${label}[${i}]`);
}
