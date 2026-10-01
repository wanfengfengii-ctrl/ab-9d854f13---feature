# 深海浮标遥测包次序恢复服务

从乱序且时间戳带误差的遥测包中联合恢复**发送次序、跨周绝对计数与整数发送时刻**，
区分真实缺包与计数器轮转，避免把下载顺序误当作采集顺序。

- 运行时零第三方依赖（仅 Node.js 内置 `http`）
- TypeScript 严格模式编译，单元 + 差分（对拍穷举参考实现）测试
- 多阶段 Docker 构建；`docker compose` 一键启动 API 与一次性 `verify` 服务

## 问题模型

输入 6–14 个唯一包，每包给出：

| 字段 | 含义 |
| --- | --- |
| `id` | 调用方指定的唯一编号（字符串或整数） |
| `remainder` | 轮转计数器余数，`0 ≤ remainder < modulus` |
| `timeLower` / `timeUpper` | 真实发送时刻所在的**整数闭区间** |

全局参数：`modulus`（模数/轮转周期）、`countLower`/`countUpper`（绝对计数搜索窗）、
`minInterval`/`maxInterval`（相邻采样间隔上下限）。

可选参数 `beatSwitch` 描述航次中的**采样节拍切换**：

```json
"beatSwitch": {
  "firstNewBeatCount": 14,
  "newMinInterval": 19,
  "newMaxInterval": 21
}
```

从绝对计数 `c` 到 `c+1` 的一步，在终点计数 `c+1 < firstNewBeatCount` 时沿用旧区间
`[minInterval, maxInterval]`，否则采用新区间 `[newMinInterval, newMaxInterval]`。
相邻已观测包之间若跨越切换点，其允许时差按**两侧步数累加**（旧步数×旧区间 +
新步数×新区间），不会把单一节拍套用到整段计数差上。省略该字段时请求、三级裁决与
响应与单节拍模式完全兼容。

服务为每包联合选择：

1. 互不相同、严格递增、落在搜索窗内且与其余数**同余**的绝对计数 `c_i`；
2. 落在各自闭区间内的整数发送时刻 `t_i`；

使复原次序中每对相邻已观测包 `(i, j)` 满足

```
Σ oldSteps·[minInterval, maxInterval] + Σ newSteps·[newMinInterval, newMaxInterval]
  包住 t_j - t_i，   oldSteps + newSteps = d = c_j - c_i ≥ 1
```

无节拍切换时所有步均为旧节拍，退化为 `d · minInterval ≤ t_j − t_i ≤ d · maxInterval`。

并按以下优先级词典序最小化：

1. 首尾已观测包之间的**缺包数**（`Σd − (n−1)`）；
2. 各选定时刻到区间中点的**总偏差**；
3. 复原的**包编号序列**（字典序；数字按数值、字符串按 UTF-16）。

若搜索窗内不存在任何整体一致的解释，返回稳定业务错误码
`NO_CONSISTENT_INTERPRETATION` 及**首个无法延伸的约束证据**（阶段、部分次序、
候选包、时间/计数允许范围）。

## HTTP API

### `GET /health`

```json
{ "status": "ok", "service": "buoy-telemetry-recovery", "time": "…" }
```

### `POST /api/v1/recover`

请求体：

```json
{
  "modulus": 10,
  "countLower": 0,
  "countUpper": 120,
  "minInterval": 9,
  "maxInterval": 11,
  "beatSwitch": {
    "firstNewBeatCount": 14,
    "newMinInterval": 19,
    "newMaxInterval": 21
  },
  "packets": [
    { "id": "A", "remainder": 8, "timeLower": 77, "timeUpper": 83 }
  ]
}
```

`beatSwitch` 可整体省略；三个字段均须为安全整数，且
`0 < newMinInterval ≤ newMaxInterval`，否则返回 `INVALID_REQUEST`。

成功（200）：

```json
{
  "status": "ok",
  "data": {
    "order": ["A", "B", "C", "D", "E", "F", "G"],
    "assignments": [
      {
        "position": 0,
        "id": "A",
        "absoluteCount": 8,
        "time": 80,
        "remainder": 8,
        "timeInterval": { "lower": 77, "upper": 83 }
      }
    ],
    "missingSegments": [
      { "fromCount": 10, "toCount": 11, "length": 2 }
    ],
    "missingCountTotal": 17,
    "adjacency": [
      {
        "index": 0,
        "fromId": "A",
        "toId": "B",
        "fromCount": 8,
        "toCount": 9,
        "countGap": 1,
        "fromTime": 80,
        "toTime": 90,
        "timeGap": 10,
        "allowedTimeGap": { "min": 9, "max": 11 },
        "missingBetween": 0,
        "congruence": { "remainder": 9, "modulus": 10 },
        "absoluteCountCongruent": true,
        "timeWithinInterval": { "from": {"lower":77,"upper":83}, "to": {"lower":87,"upper":93} },
        "satisfied": true
      }
    ],
    "observedCountRange": { "first": 8, "last": 31 }
  }
}
```

提交 `beatSwitch` 后，响应额外回显 `data.beatSwitch`，且每条 `adjacency` 增加节拍分解：

```json
{
  "countGap": 2,
  "oldSteps": 1,
  "newSteps": 1,
  "allowedTimeGap": { "min": 28, "max": 32 },
  "beatBreakdown": {
    "switchAtCount": 14,
    "old":  { "steps": 1, "minInterval": 9,  "maxInterval": 11, "minTimeGap": 9,  "maxTimeGap": 11 },
    "next": { "steps": 1, "minInterval": 19, "maxInterval": 21, "minTimeGap": 19, "maxTimeGap": 21 }
  }
}
```

`allowedTimeGap` 恒为两侧步数范围之和；未提交切换时这些字段一律不出现，旧响应不变。
整体无解时首个阻断证据的 `detail` 同时给出 `absoluteCountRange`（前后已观测/候选包的
绝对计数范围）与 `beatBreakdown`（新旧节拍步数及合成时差），帮助工程师区分真实缺包与
节拍切换冲突；种子阶段（计数窗内无法起链）则给出 `absoluteCountRange`。

错误：

| HTTP | error.code | 含义 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 请求结构/取值非法 |
| 422 | `NO_CONSISTENT_INTERPRETATION` | 搜索窗内无整体一致解释（附首个阻断约束证据） |

## 算法概述

- **边可行性区间化**：每对包的可行计数差被表达为同余等差数列与三类区间
  （原始时间区间、运行时收紧时间窗、绝对计数搜索窗）的交集，避免逐差枚举。
- **分支限界**：Held–Karp 预计算经过剩余包集合的最小计数差完成代价，作为主目标
  精确下界内联剪枝；相同 (余数, 区间) 的包做对称性破除。
- **三阶段词典序优化**：A 最小化总计数差；B 在主目标最优链上最小化中点偏差；
  C 用记忆化可行性判定贪心固定每一位最小编号。
- **时刻优化**：固定次序与计数差后，这是路径差分约束上的整数 L1 问题；通过
  "枢轴值 × 任意上下限紧约束链"枚举候选值，再以滑动窗口最短路 DP 精确求解，
  并重建字典序最小时刻向量。
- **节拍切换**：每条边的允许时差是"旧步数×旧区间 + 新步数×新区间"的合成区间，
  其关于首计数 `c0` 为分段线性（至多一条边跨越切换点）。搜索期传播存在性 `c0`
  区间，叶子用"全等旧/全等新/切换点恰好落在观测包/单条跨接边"四类首计数候选
  （跨接边的旧/新步数候选由紧约束链枢轴按旧/新步数 s 仿射枚举）做**精确认证**，
  因此不会把松弛边界误判为可行。无解证据对每条候选边按具体计数差与收窄后的
  `c0` 区间做精确扫描，给出绝对计数范围与新旧节拍分解。

## 本地开发

需要 Node.js ≥ 22。

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # vitest：单元测试 + 360 单节拍/320 节拍切换随机对拍穷举参考 + 2000 例时刻DP对拍
npm run build       # 输出 dist/
npm start           # 默认 0.0.0.0:3000
API_PORT=8080 npm start
node scripts/smoke.mjs http://127.0.0.1:8080
```

## Docker

镜像内服务监听容器内端口，容器自带 `HEALTHCHECK`。宿主机端口由宿主侧 `API_PORT`
控制（默认 3000）：

```bash
# 启动 API（宿主机 8080 -> 容器 8080）
API_PORT=8080 docker compose up --build -d api

# 一键校验：等待 API 健康 -> TypeScript 构建 -> 代码测试 -> HTTP 冒烟
# verify 为一次性服务，按自身退出码结束（成功 0 / 失败非 0）
docker compose up --build verify
docker compose ps   # verify 状态为 Exited (0)
```

`verify` 服务通过 `depends_on: condition: service_healthy` 等待 API 健康后执行
`scripts/verify.sh`，其中的跨周含缺包样例即
`tests/fixtures/sample.ts` / `scripts/smoke.mjs` 所用样例。
