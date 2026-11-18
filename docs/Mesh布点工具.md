# 通用 Spine Mesh 布点工具

## 终端 CLI

在仓库执行 `npm ci` 和 `npm run build`，之后可从仓库调用以下命令。默认工作区是当前目录，通过 `--workspace` 可指定资产根目录。输入、清单、地标和输出目录均按该工作区解析，`--spine` 指向本机已安装的编辑器。输出目录必须尚不存在，其父目录须已存在。

~~~powershell
npm run mesh -- plan --workspace 'D:\鱼项目' --input 'Tuna\images' --out mesh-plan
npm run mesh -- candidate --workspace 'D:\鱼项目' --job fish-mesh-job.json --spine 'D:\Program Files\Spine\Spine.com' --out mesh-candidates
~~~

第一行读取一个 PNG 或目录内按文件名排序的 PNG。每个切片输出 `mesh.json` 和 `overlay.png`。`mesh.json` 包含原图尺寸、归一化点表 `uv`、三角索引 `triangles` 和外圈点数 `hull`。三角索引是点表中的零基索引，像素坐标的 Y 轴向下。

第二行执行前，将仓库中的 [鱼项目样例](../example-json/fish-mesh-job.json) 复制到选定的资产工作区。清单的 `projects` 数组为每个工程提供 `id`、`project` 和 `targets`。每个目标需要 `skin`、`slot`、`attachment` 和 `png`。使用 `{"id":"Bream","skip":"沿用人工调整的网格"}` 可跳过项目。

两种模式都可通过 `--landmarks` 读取 JSON 数组。候选项目也支持在单个目标的 `landmarks` 中补充地标。`preserve` 保留最接近给定坐标的轮廓位置，`densify` 在切片内部局部加点。`uv` 以切片左上角为原点，分量范围为 `0–1`。

~~~json
[
  {"intent":"preserve","uv":[0.98,0.18]},
  {"intent":"densify","uv":[0.81,0.52]}
]
~~~

CLI 与 MCP 共用布点、批处理和编辑器回读模块。终端仍按原有参数独立执行，独立 CLI 的迁移基线保存在 Git 提交 `1b9420f`。

## MCP 配置与调用

在服务启动环境中设置本机编辑器的绝对路径。下面是在仓库目录直接启动 stdio 服务的 PowerShell 示例。由 MCP 客户端启动时，在该服务的环境变量配置中设置同一个值，再重新启动服务。

~~~powershell
$env:SPINE_MCP_WORKSPACE = 'D:\鱼项目'
$env:SPINE_MCP_MESH_EDITOR = 'D:\Program Files\Spine\Spine.com'
node dist/server.js
~~~

先构建服务，再通过 `tools/list` 发现工具。`spine_mesh_plan` 的调用参数示例为 `{"inputPath":"Tuna/images","outputDir":"mesh-plan-mcp"}`。`spine_mesh_build_candidate` 的调用参数示例为 `{"jobPath":"fish-mesh-job.json","outputDir":"mesh-candidates-mcp"}`。先将上文的鱼项目样例清单放到资产工作区，再调用候选工具。

两个工具都支持 `landmarksPath` 和已登记工作区的 `projectId`。输出目录必须尚不存在，父目录须已存在。布点入口直接读取 PNG。候选入口只接受服务侧配置的编辑器，配置缺失、无法启动或版本不符时会在创建输出目录前报错。

MCP 响应包含 `summaryPath` 和每项产物的工作区相对路径。完整数据保存在 `mesh.json`、候选工程导出物、`mesh-report.json` 和叠图中。显式跳过属于有效结果，失败或因不支持而跳过会令批次 `ok` 为 `false`，其余项目继续处理。取消会等待正在运行的编辑器步骤结束，清理当前未发布的临时目录，并保留已发布的项目目录。

## 候选边界

候选模式要求源工程为 **Spine 4.3.26**、单骨架，目标为已有权重的独立 Mesh。工程使用内部相对贴图目录，目标 PNG 对应附件原始贴图。首版对标准继承的骨骼和 `rotate`、`translate`、`scale`、`shear` 采样。有 `deform`、关联 Mesh、约束、其他骨骼求值模式或无法可靠覆盖的工程会给出原因。PNG 布点模式独立于 Spine 版本。

工具使用同版本编辑器导出带 Nonessential 数据的临时 `.skel`，只有 UV、三角形和权重等记录能和源导出唯一匹配时才替换。导入候选后重新导出 JSON 和图集。回读差异只允许目标 Mesh 的几何字段和派生的骨架包围盒、哈希。原始切片复制到候选工程，新的图集经编辑器解包检查对应切片的尺寸和 Alpha。一次工程里的多个选定目标作为同一个候选交付。 [Spine CLI](https://esotericsoftware.com/spine-command-line-interface) · [二进制导出格式](https://esotericsoftware.com/spine-binary-format)

## 验收

- `summary.json` 和标准输出只列状态、点数变化、失败原因及产物路径。未预期的跳过或失败会返回非零退出码，其他项目继续处理。
- 候选目录中的 `mesh-report.json` 分开记录数值与 Spine 编辑器回读状态。数值检查包含可见像素覆盖、三角翻折和关键帧及帧间采样的形变偏差。最大偏差为切片长边的 `0.6%`，下限 `1 px`。布点叠图供人工查看局部走线。
- 用 `npm run build` 和 `npm test` 验证自动布点、权重转移、超范围输入和差异限制。鱼项目验收时，核对 14 个候选工程的点数下降、`idle` 关键帧和原始文件哈希，确认 `Bream` 为显式跳过项。
- 验证 MCP 与 CLI 的真实候选时，将 `SPINE_TEST_MESH_TUNA` 指向金枪鱼源工程目录，并在同一测试环境设置 `SPINE_MCP_MESH_EDITOR`。测试复制源工程到隔离目录，通过真实 stdio 核对布点、`idle` 时间线、原生回读、形变报告、源文件字节和混合批次状态。
