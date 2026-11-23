import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import {
  computeSessionTelemetry,
  fmtNum,
  fmtTok,
  type GoUsageSummary,
  type SessionTelemetry,
  type TurnStat,
} from "./metrics"

function asciiBar(pct: number, width = 16): string {
  const clamped = Math.max(0, Math.min(100, pct))
  const filled = Math.round((clamped / 100) * width)
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled))
}

function asciiDualBar(firstPct: number, secondPct: number, width = 20): { a: string; b: string; rest: string } {
  const aCount = Math.min(width, Math.max(firstPct > 0 ? 1 : 0, Math.round((firstPct / 100) * width)))
  const bCount = Math.min(
    Math.max(0, width - aCount),
    Math.max(secondPct > 0 ? 1 : 0, Math.round((secondPct / 100) * width)),
  )
  const restCount = Math.max(0, width - aCount - bCount)
  return {
    a: "█".repeat(aCount),
    b: "▓".repeat(bCount),
    rest: "░".repeat(restCount),
  }
}

export default Plugin.define({
  id: "telemetry.tui",
  setup(context) {
    const [prefs, updatePrefs] = context.storage.store("prefs", {
      initial: {
        layout: "compact" as "compact" | "detailed",
        cacheMode: "session" as "session" | "step",
      },
    })

    const [goLimits, setGoLimits] = createSignal<any>(undefined)
    const [tick, setTick] = createSignal(Date.now())

    const refreshGoLimits = async () => {
      try {
        const loc = context.location ?? context.data.location.default()
        const client: any = context.client
        const res = await (client.usage?.limits
          ? client.usage.limits({ location: loc })
          : client.experimental?.usage?.limits?.({ location: loc }))
        const payload = res?.data ?? res
        if (payload) setGoLimits(payload)
      } catch {
        // Ignore when offline or signed out
      }
    }

    void refreshGoLimits()
    const timer = setInterval(() => {
      setTick(Date.now())
      void refreshGoLimits()
    }, 45_000)

    const stopUsage = context.data.on("session.usage.updated", () => {
      setTick(Date.now())
      void refreshGoLimits()
    })
    const stopStep = context.data.on("session.step.ended", () => {
      setTick(Date.now())
    })

    const activeSessionID = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    const useTelemetry = (sessionIDAccessor: () => string | undefined) =>
      createMemo<SessionTelemetry | undefined>(() => {
        const sid = sessionIDAccessor()
        if (!sid) return undefined
        const info = context.data.session.get(sid)
        const messages = context.data.session.message.list(sid) ?? []
        const status = context.data.session.status(sid)
        const cost = context.data.session.cost(sid)
        const loc = info?.location ?? context.location ?? context.data.location.default()
        const models = context.data.location.model.list(loc) ?? []
        return computeSessionTelemetry({
          messages,
          sessionInfo: info,
          sessionStatus: typeof status === "string" ? status : (status as any)?.type,
          sessionCost: cost,
          models,
          limitsInfo: goLimits(),
          now: tick(),
        })
      })

    const openMetricsDialog = (sid?: string) => {
      const targetID = sid ?? activeSessionID()
      context.ui.dialog.set({ size: "large", centered: true })
      context.ui.dialog.show(() => <MetricsDialog sessionID={targetID} />)
    }

    function MetricsDialog(props: { sessionID?: string }) {
      const ctx = usePlugin()
      const [level, setLevel] = createSignal<"l1" | "l2" | "turns">("l2")
      const tel = useTelemetry(() => props.sessionID ?? activeSessionID())

      ctx.keymap.layer(() => ({
        mode: "modal",
        commands: [
          {
            id: "telemetry.dialog.tab",
            title: "切换统计视图 (L1 / L2 / 每轮明细)",
            bind: "tab",
            run: () => setLevel((v) => (v === "l1" ? "l2" : v === "l2" ? "turns" : "l1")),
          },
          {
            id: "telemetry.dialog.cachemode",
            title: "切换缓存率口径 (会话累计 / 单步)",
            bind: "c",
            run: () => {
              void updatePrefs((d) => {
                d.cacheMode = d.cacheMode === "session" ? "step" : "session"
              })
            },
          },
          {
            id: "telemetry.dialog.layout",
            title: "切换状态栏密度 (紧凑 / 详细)",
            bind: "d",
            run: () => {
              void updatePrefs((d) => {
                d.layout = d.layout === "compact" ? "detailed" : "compact"
              })
            },
          },
          {
            id: "telemetry.dialog.refresh",
            title: "刷新 OpenCode Go 额度",
            bind: "r",
            run: () => void refreshGoLimits(),
          },
        ],
      }))

      return (
        <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={ctx.theme.text.base}>
              <b>● Telemetry &amp; OpenCode Go 用量面板</b>
            </text>
            <text fg={ctx.theme.text.muted}>
              [Tab] 视图:{level().toUpperCase()} · [C] 口径:{prefs.cacheMode === "step" ? "单步" : "累计"} · [D] 状态栏:
              {prefs.layout === "detailed" ? "详细" : "紧凑"} · [R] 刷新 · [Esc] 关闭
            </text>
          </box>

          <Show
            when={tel()}
            fallback={<text fg={ctx.theme.text.muted}>请先进入一个会话以查看实时统计指标。</text>}
          >
            {(t) => {
              const step = () => t().lastStep
              const tot = () => t().totals
              const go = () => t().go
              const ctxBar = () => {
                const s = step()
                if (!s || t().contextLimit <= 0) return asciiDualBar(0, 0, 24)
                const newPct = (s.tokens.input / t().contextLimit) * 100
                const cachePct = ((s.tokens.cacheRead + s.tokens.cacheWrite) / t().contextLimit) * 100
                return asciiDualBar(newPct, cachePct, 24)
              }

              return (
                <box flexDirection="column" gap={1}>
                  {/* L1 Bento Summary Row */}
                  <box flexDirection="row" justifyContent="space-between" gap={2}>
                    <box flexDirection="column">
                      <text fg={ctx.theme.text.muted}>生成速度 (Speed)</text>
                      <text fg={ctx.theme.text.base}>
                        <b>{(step()?.displayTps ?? tot().avgStreamTps).toFixed(1)} tok/s</b>
                      </text>
                      <text fg={ctx.theme.text.muted}>
                        端到端 {(step()?.e2eTps ?? tot().avgE2eTps).toFixed(1)} t/s · TTFT{" "}
                        {(step()?.ttftSec ?? 0).toFixed(2)}s
                      </text>
                    </box>

                    <box flexDirection="column">
                      <text fg={ctx.theme.text.muted}>上下文容量 (Context)</text>
                      <text fg={ctx.theme.text.base}>
                        <b>
                          {t().compactedPending ? "已压缩" : `${t().contextPct}%`} ({fmtTok(t().contextTokens)} /{" "}
                          {t().contextLimitLabel})
                        </b>
                      </text>
                      <text fg={ctx.theme.text.muted}>
                        [{ctxBar().a}
                        {ctxBar().b}
                        {ctxBar().rest}] 余 {fmtTok(t().contextRemainTokens)}
                      </text>
                    </box>

                    <box flexDirection="column">
                      <text fg={ctx.theme.text.muted}>缓存命中率 (Cache Hit)</text>
                      <text fg={ctx.theme.text.base}>
                        <b>累计 {tot().sessionCacheRate}%</b>
                      </text>
                      <text fg={ctx.theme.text.muted}>
                        本步 {step()?.cacheRate ?? 0}% · 读缓存 {fmtTok(tot().cacheRead)}
                      </text>
                    </box>
                  </box>

                  {/* OpenCode Go Allowance Section */}
                  <Show when={go()}>
                    {(g) => (
                      <box flexDirection="column">
                        <text fg={ctx.theme.text.base}>
                          <b>OpenCode Go 额度 ({g().workspaceName ?? "Default"})</b>
                        </text>
                        <text fg={ctx.theme.text.muted}>
                          5小时窗口 [{asciiBar(g().rolling.percent, 14)}] {g().rolling.percent}% (重置于{" "}
                          {g().rolling.resetsInLabel})
                        </text>
                        <text fg={ctx.theme.text.muted}>
                          本周额度  [{asciiBar(g().weekly.percent, 14)}] {g().weekly.percent}% (重置于{" "}
                          {g().weekly.resetsInLabel})
                        </text>
                        <text fg={ctx.theme.text.muted}>
                          本月额度  [{asciiBar(g().monthly.percent, 14)}] {g().monthly.percent}% (重置于{" "}
                          {g().monthly.resetsInLabel})
                        </text>
                      </box>
                    )}
                  </Show>

                  {/* L2 Breakdown */}
                  <Show when={level() === "l2"}>
                    <box flexDirection="column">
                      <text fg={ctx.theme.text.base}>
                        <b>
                          本步与会话累计明细 ({t().userTurnCount} 轮提问 / {t().assistantStepCount} 次模型请求 · 总耗时{" "}
                          {tot().totalDurationSec}s)
                        </b>
                      </text>
                      <text fg={ctx.theme.text.muted}>
                        本步输入: 新增 {fmtNum(step()?.tokens.input)} · 写缓存 {fmtNum(step()?.tokens.cacheWrite)} ·
                        读缓存 {fmtNum(step()?.tokens.cacheRead)} ({step()?.cacheRate ?? 0}%)
                      </text>
                      <text fg={ctx.theme.text.muted}>
                        本步输出: 共 {fmtNum((step()?.tokens.output ?? 0) + (step()?.tokens.reasoning ?? 0))} (思考{" "}
                        {fmtNum(step()?.tokens.reasoning)} · 正文/工具 {fmtNum(step()?.tokens.output)}) · 耗时{" "}
                        {(step()?.totalSec ?? 0).toFixed(2)}s (TTFT {(step()?.ttftSec ?? 0).toFixed(2)}s / 流式{" "}
                        {(step()?.streamSec ?? 0).toFixed(2)}s)
                      </text>
                      <text fg={ctx.theme.text.muted}>
                        累计输入: 总 {fmtTok(tot().promptTokens)} (新增 {fmtTok(tot().input)} · 写缓存{" "}
                        {fmtTok(tot().cacheWrite)} · 读缓存 {fmtTok(tot().cacheRead)} · 命中率{" "}
                        {tot().sessionCacheRate}%)
                      </text>
                      <text fg={ctx.theme.text.muted}>
                        累计输出: 总 {fmtTok(tot().totalOutTokens)} (思考链 {fmtTok(tot().reasoning)} · 正文/工具{" "}
                        {fmtTok(tot().output)})
                      </text>
                    </box>
                  </Show>

                  {/* Per-turn list */}
                  <Show when={level() === "turns"}>
                    <box flexDirection="column">
                      <text fg={ctx.theme.text.base}>
                        <b>每轮对话尾部统计 (最近 {Math.min(8, t().turns.length)} 轮)</b>
                      </text>
                      <For each={t().turns.slice(-8).toReversed()}>
                        {(turn: TurnStat) => (
                          <text fg={ctx.theme.text.muted}>
                            #{turn.turnIndex} [{turn.modelLabel}] {turn.steps}步 · {Math.round(turn.displayTps)} t/s ·
                            Ctx {fmtTok(turn.lastContextTokens)}/{fmtTok(turn.contextLimit)} ({turn.contextPct}%) · In{" "}
                            {fmtTok(turn.promptTokens)} · Out {fmtTok(turn.totalOutTokens)} (思{fmtTok(turn.tokens.reasoning)}
                            /正{fmtTok(turn.tokens.output)}) · Cache {turn.cacheRate}% · {turn.totalSec}s
                          </text>
                        )}
                      </For>
                    </box>
                  </Show>
                </box>
              )
            }}
          </Show>
        </box>
      )
    }

    // 1. Prompt Footer Status Bar (● 248 tok/s · Ctx 42% · Cache 90.9% · Go 32%)
    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const tel = useTelemetry(() => input.sessionID)
        return (
          <Show when={tel()}>
            {(t) => {
              const dotColor = () => {
                const st = t().status
                if (st === "error") return (context.theme.text as any).feedback?.error?.base ?? context.theme.text.base
                if (st === "waiting")
                  return (context.theme.text as any).feedback?.warning?.base ?? context.theme.text.base
                return context.theme.text.base
              }

              const summaryText = () => {
                const cur = t()
                const s = cur.lastStep
                const tps = Math.round(s?.displayTps ?? cur.totals.avgStreamTps ?? 0)
                const cacheVal = prefs.cacheMode === "step" ? (s?.cacheRate ?? 0) : cur.totals.sessionCacheRate
                const goStr = cur.go
                  ? ` · Go 5h:${cur.go.rolling.percent}%/M:${cur.go.monthly.percent}%`
                  : ""

                if (prefs.layout === "detailed") {
                  const ttft = (s?.ttftSec ?? 0).toFixed(1)
                  const ctxStr = cur.compactedPending
                    ? "Ctx 已压缩"
                    : `Ctx ${fmtTok(cur.contextTokens)}/${cur.contextLimitLabel} (${cur.contextPct}%)`
                  const outStr = fmtTok((s?.tokens.output ?? 0) + (s?.tokens.reasoning ?? 0))
                  return `${tps} tok/s · TTFT ${ttft}s · ${ctxStr} · Out ${outStr} · Cache ${cacheVal}%${goStr}`
                }

                const ctxCompact = cur.compactedPending ? "Ctx 已压缩" : `Ctx ${cur.contextPct}%`
                return `${tps} tok/s · ${ctxCompact} · Cache ${cacheVal}%${goStr}`
              }

              return (
                <box flexDirection="row" gap={1} onMouseUp={() => openMetricsDialog(input.sessionID)}>
                  <text fg={dotColor()}>●</text>
                  <text fg={context.theme.text.muted}>{summaryText()}</text>
                </box>
              )
            }}
          </Show>
        )
      },
    })

    // 2. Sidebar Telemetry & OpenCode Go Card
    context.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        const tel = useTelemetry(() => input.sessionID)
        return (
          <Show when={tel()}>
            {(t) => (
              <box flexDirection="column" onMouseUp={() => openMetricsDialog(input.sessionID)}>
                <text fg={context.theme.text.base}>
                  <b>Telemetry 统计</b>
                </text>
                <text fg={context.theme.text.muted}>
                  速度 {Math.round(t().lastStep?.displayTps ?? t().totals.avgStreamTps)} t/s · TTFT{" "}
                  {(t().lastStep?.ttftSec ?? 0).toFixed(2)}s
                </text>
                <text fg={context.theme.text.muted}>
                  缓存 累计 {t().totals.sessionCacheRate}% (本步 {t().lastStep?.cacheRate ?? 0}%)
                </text>
                <text fg={context.theme.text.muted}>
                  输入 {fmtTok(t().totals.promptTokens)} (读缓存 {fmtTok(t().totals.cacheRead)})
                </text>
                <text fg={context.theme.text.muted}>
                  输出 {fmtTok(t().totals.totalOutTokens)} (思 {fmtTok(t().totals.reasoning)} / 正{" "}
                  {fmtTok(t().totals.output)})
                </text>
                <Show when={t().go}>
                  {(g: () => GoUsageSummary) => (
                    <text fg={context.theme.text.muted}>
                      Go额度 5h:{g().rolling.percent}% · 周:{g().weekly.percent}% · 月:{g().monthly.percent}%
                    </text>
                  )}
                </Show>
              </box>
            )}
          </Show>
        )
      },
    })

    // 3. Slash command /metrics and Ctrl+G shortcut
    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "telemetry.open",
              title: "查看 Telemetry 详细会话统计与 Go 额度",
              group: "Telemetry",
              bind: "ctrl+g",
              palette: true,
              slash: { name: "metrics", aliases: ["telemetry", "opg"] },
              run: () => openMetricsDialog(),
            },
          ],
        }))
        return null
      },
    })

    return () => {
      clearInterval(timer)
      stopUsage()
      stopStep()
    }
  },
})
