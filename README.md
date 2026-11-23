<div align="center">

<h1>opencode-telemetry</h1>

<p><strong>OpenCode 桌面端 (GUI) 与终端 CLI (TUI) 的四态实时会话状态胶囊、一/二级 Bento 用量统计面板、每轮对话明细与 OpenCode Go 额度监控插件</strong></p>

<p>
  <img src="https://img.shields.io/static/v1?label=OpenCode&message=v2.4%2B&color=3B82F6&labelColor=262626" alt="OpenCode v2.4+">
  <img src="https://img.shields.io/static/v1?label=surfaces&message=Desktop%20GUI%20%C2%B7%20CLI%20TUI&color=10B981&labelColor=262626" alt="Desktop GUI · CLI TUI">
  <img src="https://img.shields.io/static/v1?label=platform&message=Windows%20%C2%B7%20macOS%20%C2%B7%20Linux&color=6366F1&labelColor=262626" alt="Windows · macOS · Linux">
  <a href="LICENSE"><img src="https://img.shields.io/static/v1?label=license&message=MIT&color=10B981&labelColor=262626" alt="MIT License"></a>
</p>

</div>

---

## 核心特性

| 模块 | 能力说明 | 适用端 |
| :--- | :--- | :--- |
| **四态实时状态胶囊** | 输入框上方常驻胶囊（`● 142 tok/s · Ctx 44% · Cache 95% · Go 16%/35%`），带就绪 / 生成中 / 长耗时等待或重试 / 执行异常 四态动态呼吸灯，支持 `紧凑 (Compact)` 与 `详细 (Detailed)` 两种布局密度 | 桌面端 GUI · 终端 TUI |
| **一级 Bento 概览面板 (L1)** | 三宫格展示 **生成速率**（流式 `t/s` + 端到端均值 + `TTFT`）、**上下文容量**（百分比 + 剩余/上限，`>=75%` 黄警、`>=90%` 红警、`/compact` 压缩态识别）、**累计缓存命中率**（累计 `%` + 本步 `%`）与当前上下文构成分段进度条（新增 / 写缓存 / 读缓存） | 桌面端 GUI · 终端 TUI |
| **OpenCode Go 额度监控** | 实时同步并显示 **5小时滚动窗口 (`rolling`)**、**本周额度 (`weekly`)**、**本月额度 (`monthly`)** 的已用百分比、彩色进度条与重置倒计时，支持一键直达 `OpenCode Console ↗` | 桌面端 GUI · 终端 TUI |
| **二级完整明细面板 (L2)** | 展开查看 **响应耗时分段条**（`TTFT` vs `流式耗时`）、**本步输出分段条**（`思考链 Reasoning` vs `正文/工具 Output`）、**本轮多步聚合**（多工具调用回合自动合并）与 **当前会话累计输入/输出构成** | 桌面端 GUI · 终端 TUI |
| **每轮对话尾部统计** | 按提问轮次倒序展示每轮使用的模型、请求步数、流式与端到端 `t/s`、上下文占比、新增/读缓存输入拆分、思考/正文输出拆分、`TTFT` 与总耗时 | 桌面端 GUI · 终端 TUI |
| **原生设置页 & 固定侧栏** | 桌面端直接嵌入 **设置 (Settings) → 实时统计 (Telemetry)** 可视化管理偏好；支持一键将统计面板固定到会话右侧边栏 | 桌面端 GUI |

---

## 快速安装（在其他电脑或给其他人使用）

### 方式一：OpenCode CLI 一键安装（推荐，支持自动检查与更新）

在任意装有 OpenCode v2 的电脑上运行一条命令即可同时激活 **桌面端 GUI** 与 **终端 TUI**：

```bash
opencode plugin add github:Starkxim/opencode-telemetry#main
```

> 使用 `#main` 分支引用时，OpenCode 会在启动及后台自动检查更新，也可随时手动执行 `opencode plugin update` 升级到最新版。

或在全局配置文件 `~/.config/opencode/opencode.json`（Windows 为 `%USERPROFILE%\.config\opencode\opencode.json`）中添加：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "github:Starkxim/opencode-telemetry#main"
  ]
}
```

### 方式二：Git 克隆到本地插件发现目录（适合本地二次开发）

OpenCode 会自动发现并热加载 `~/.config/opencode/plugins/` 下的所有插件目录：

```bash
# macOS / Linux
git clone https://github.com/Starkxim/opencode-telemetry.git ~/.config/opencode/plugins/telemetry

# Windows PowerShell
git clone https://github.com/Starkxim/opencode-telemetry.git "$env:USERPROFILE\.config\opencode\plugins\telemetry"
```

克隆完成后无需重启，或运行 `opencode reload` 即可立即生效。

---

## 使用指南

### 1. 桌面端（OpenCode Desktop）

- **状态胶囊**：进入任意会话后自动显示在输入框左上方。点击胶囊即可弹出 **L1/L2 Bento 统计面板**。
- **展开明细 / 每轮统计 / 固定侧栏**：
  - 点击悬浮面板底部 **「展开明细 ▾」** 切换二级（L2）完整构成面板
  - 点击 **「每轮明细」** 查看每轮对话尾部统计列表
  - 点击 **「侧栏」**（或按快捷键 **`Ctrl+Shift+M`** / `Cmd+Shift+M`，或输入斜杠命令 **`/metrics`**）将统计面板固定到右侧边栏
- **可视化设置**：打开 **设置 (Settings) → 实时统计 (Telemetry)**，可自由切换：
  - 状态胶囊布局密度：`紧凑 (Compact)` / `详细 (Detailed)`
  - 胶囊缓存命中率口径：`会话累计命中率 (Session)` / `单步命中率 (Step)`
  - 是否在胶囊末尾显示 OpenCode Go 额度
  - 点击胶囊是否默认展开二级（L2）明细面板

### 2. 终端 CLI（OpenCode TUI）

- **底部单行状态栏**：输入框底部实时显示 `● 142t/s · Ctx 44% · Cache 95% · Go 16%/35%`（鼠标点击可打开详情弹窗）。
- **右侧边栏卡片**：右侧边栏常驻显示 `Telemetry 统计`（速率、TTFT、累计/本步缓存率、输入/输出拆分、Go 额度）。
- **交互式大号统计弹窗**：
  - 输入斜杠命令 **`/metrics`**（或别名 **`/telemetry`**、**`/opg`**），或按快捷键 **`Ctrl+G`** 打开弹窗
  - 弹窗内快捷键：
    - `Tab`：在 **L1 概览 / L2 完整明细 / 每轮对话统计** 之间切换
    - `C`：切换缓存命中率口径（会话累计 / 单步）
    - `D`：切换底部状态栏密度（紧凑 / 详细）
    - `R`：立即刷新 OpenCode Go 额度

---

## 目录结构

```text
opencode-telemetry/
├── index.ts                # Server 入口（提供插件 ID 与多端发现锚点）
├── metrics.ts              # 统计计算引擎（四态状态机、tok/s、TTFT、缓存率、每轮聚合、Go 额度解析）
├── tui.tsx                 # OpenCode CLI (TUI) 插件实现
├── gui-experimental.cjs    # OpenCode Desktop (GUI) 预构建 CommonJS 捆绑包
├── package.json            # OpenCode 多端插件导出声明 (., ./server, ./tui, ./gui-experimental)
├── LICENSE                 # MIT License
└── README.md               # 使用与安装文档
```

## 开源协议

基于 [MIT License](LICENSE) 开源。
