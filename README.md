# 区域覆盖资料查看器

用于检查授权来源的一份原始资料并留存接收凭据。当前提供资料预览、原件接收、凭据列表与摘要回读，资料源可以在本地独立运行。

## 环境与运行

使用 Node.js 22.23.4，无第三方运行包。安装、检查与测试：

```sh
npm ci --ignore-scripts --offline
npm run build
npm test
npm run demo
```

`demo` 临时启动来源和查看服务，展示当前资料并核对保存后的原件；结束时关闭所有监听并移除临时目录。不会连接外部来源。`test` 校验已有预览、资料控制和原件持久化；测试通过只说明当前版本已有能力正常。

需要交互时分别运行 `npm run source` 与 `npm start`。来源默认监听本机 4310 端口，应用默认监听 4320；可用 `PORT`、`SOURCE_URL`、`DATA_DIR` 配置。`GET /preview` 获取预览，`POST /receipts` 接收当前资料，`GET /receipts` 查询凭据，`GET /objects/<摘要>` 回读原件。应用只允许配置到本机的资料服务。

按范围领取温度覆盖：`POST /subsets`，请求体如 `{"coverageId":"park-temp","trims":{"Lat":[30.2,30.3],"Long":[120,121.6]}}`。服务先读取来源公布的轴、方向、单位、网格、nil 值、格式与单次网格上限，再把需求对齐到网格点并分块领取；每块独立核对版本、原点、步长、形状、物理范围和无数据标记，重叠网格点去重，描述更新导致的版本变化会中止并拒绝新旧网格拼接。凭据 `GET /subsets`、`GET /subsets/<id>` 回读，其中说明多取范围、出界未取得部分、时间轴限制和每块来源原件摘要；不做插值或地图展示。契约细节见 `docs/资料接口.md`。

## 目录

`source/` 负责资料源的发布日期和传输状态；`src/decode.mjs` 解释一份来源资料；`src/catalog.mjs` 管理不可变原件及接收凭据；`src/subset.mjs` 负责按范围领取的轴/网格理解、分块规划、逐块核对与去重合并；`src/app.mjs` 提供查看服务。资料含义及来源控制见 `docs/资料接口.md`。

## 容器

```sh
docker build -t wcs-subsets .
docker run --rm --network none wcs-subsets
```

镜像固定 Node.js 版本，构建期间不下载 npm 运行依赖。运行产生的原件保存在 `DATA_DIR`，不应写回来源文件。
