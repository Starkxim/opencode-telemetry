// Pure telemetry calculation engine shared by TUI and GUI plugins.

export interface TokenBreakdown {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export interface StepStat {
  readonly index: number
  readonly id: string
  readonly turnIndex: number
  readonly modelID: string
  readonly providerID: string
  readonly variant?: string
  readonly agent?: string
  readonly tokens: TokenBreakdown
  readonly promptTokens: number
  readonly totalTokens: number
  readonly cacheRate: number
  readonly ttftSec: number
  readonly streamSec: number
  readonly totalSec: number
  readonly streamTps: number
  readonly e2eTps: number
  readonly displayTps: number
  readonly cost: number
  readonly finish?: string
  readonly hasError: boolean
  readonly isRetrying: boolean
  readonly completed: boolean
}

export interface TurnStat {
  readonly turnIndex: number
  readonly userPreview: string
  readonly steps: number
  readonly modelLabel: string
  readonly tokens: TokenBreakdown
  readonly promptTokens: number
  readonly totalOutTokens: number
  readonly lastContextTokens: number
  readonly contextLimit: number
  readonly contextPct: number
  readonly cacheRate: number
  readonly ttftSec: number
  readonly streamSec: number
  readonly totalSec: number
  readonly streamTps: number
  readonly e2eTps: number
  readonly displayTps: number
  readonly cost: number
}

export interface GoMeter {
  readonly percent: number
  readonly limited: boolean
  readonly resetsAt: number
  readonly resetsInLabel: string
}

export interface GoUsageSummary {
  readonly workspaceName?: string
  readonly usageURL?: string
  readonly rolling: GoMeter
  readonly weekly: GoMeter
  readonly monthly: GoMeter
}

export type TelemetryStatus = "ready" | "running" | "waiting" | "error"

export interface SessionTelemetry {
  readonly status: TelemetryStatus
  readonly statusLabel: string
  readonly compacting: boolean
  readonly compactedPending: boolean
  readonly lastError?: string
  readonly userTurnCount: number
  readonly assistantStepCount: number
  readonly contextTokens: number
  readonly contextLimit: number
  readonly contextLimitLabel: string
  readonly contextRemainTokens: number
  readonly contextPct: number
  readonly contextLevel: "ok" | "warn" | "crit" | "compacted"
  readonly lastStep?: StepStat
  readonly lastTurn?: TurnStat
  readonly turns: readonly TurnStat[]
  readonly totals: TokenBreakdown & {
    readonly promptTokens: number
    readonly totalOutTokens: number
    readonly sessionCacheRate: number
    readonly avgStreamTps: number
    readonly avgE2eTps: number
    readonly totalDurationSec: number
    readonly cost: number
  }
  readonly go?: GoUsageSummary
}

export function fmtTok(n: number | undefined | null): string {
  if (!n || n <= 0) return "0"
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, "") + "M"
  if (n >= 10_000) return Math.round(n / 1_000) + "k"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(Math.round(n))
}

export function fmtNum(n: number | undefined | null): string {
  return Math.round(n || 0).toLocaleString("en-US")
}

export function fmtContextLimit(tokens: number | undefined | null): string {
  if (!tokens || tokens <= 0) return "200k"
  if (tokens >= 1_000_000) {
    if (tokens === 1_000_000 || tokens === 1_048_576) return "1M"
    return (tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, "") + "M"
  }
  return Math.round(tokens / 1_000) + "k"
}

export function fmtDurationUntil(resetsAtMs: number | undefined | null, now = Date.now()): string {
  if (!resetsAtMs || resetsAtMs <= now) return "即将重置"
  const diffMin = Math.max(1, Math.floor((resetsAtMs - now) / 60_000))
  const days = Math.floor(diffMin / 1440)
  const hours = Math.floor((diffMin % 1440) / 60)
  const mins = diffMin % 60
  if (days > 0) return `${days}天 ${hours}小时`
  if (hours > 0) return `${hours}小时 ${mins}分`
  return `${mins}分钟`
}

export function computeSegPcts(values: readonly number[], targetTotalPct = 100, minVisiblePct = 2): number[] {
  const sum = values.reduce((acc, v) => acc + (v > 0 ? v : 0), 0)
  const clamped = Math.max(0, Math.min(100, targetTotalPct))
  if (sum <= 0 || clamped <= 0) return values.map(() => 0)
  const raw = values.map((v) => (v > 0 ? (v / sum) * clamped : 0))
  const nonZero: number[] = []
  for (let i = 0; i < values.length; i++) {
    if (values[i] > 0) nonZero.push(i)
  }
  if (nonZero.length > 1 && clamped > minVisiblePct * nonZero.length) {
    let deficit = 0
    let flexSum = 0
    for (const idx of nonZero) {
      if (raw[idx] < minVisiblePct) {
        deficit += minVisiblePct - raw[idx]
        raw[idx] = minVisiblePct
      } else {
        flexSum += raw[idx] - minVisiblePct
      }
    }
    if (deficit > 0 && flexSum > 0) {
      const ratio = Math.min(1, deficit / flexSum)
      for (const idx of nonZero) {
        if (raw[idx] > minVisiblePct) {
          raw[idx] -= (raw[idx] - minVisiblePct) * ratio
        }
      }
    }
  }
  return raw.map((pct) => Number(pct.toFixed(1)))
}

export function parseGoLimits(limitsInfo: any, now = Date.now()): GoUsageSummary | undefined {
  const go = limitsInfo?.go
  if (!go) return undefined
  const mk = (m: any): GoMeter => ({
    percent: Math.round(Number(m?.percent ?? 0)),
    limited: Boolean(m?.limited || m?.status === "rate-limited" || Number(m?.percent ?? 0) >= 100),
    resetsAt: Number(m?.resetsAt ?? 0),
    resetsInLabel: fmtDurationUntil(Number(m?.resetsAt ?? 0), now),
  })
  return {
    workspaceName: limitsInfo?.workspace?.name,
    usageURL: limitsInfo?.workspace?.usageURL,
    rolling: mk(go.rolling),
    weekly: mk(go.weekly),
    monthly: mk(go.monthly),
  }
}

export function computeSessionTelemetry(input: {
  messages: readonly any[]
  sessionInfo?: any
  sessionStatus?: string
  sessionCost?: number
  models?: readonly any[]
  limitsInfo?: any
  now?: number
}): SessionTelemetry {
  const now = input.now ?? Date.now()
  const allMessages = input.messages ?? []
  const revertID = input.sessionInfo?.revert?.messageID
  const boundaryIdx = revertID ? allMessages.findIndex((m) => m?.id === revertID) : -1
  const messages = boundaryIdx >= 0 ? allMessages.slice(0, boundaryIdx) : allMessages

  const modelCatalog = input.models ?? []
  const findContextLimit = (providerID?: string, modelID?: string): number => {
    if (providerID && modelID) {
      const match = modelCatalog.find((m) => m?.providerID === providerID && m?.id === modelID && m?.status !== "deprecated")
      if (match?.limit?.context && match.limit.context > 0) return match.limit.context
    }
    const fallbackRef = input.sessionInfo?.model
    if (fallbackRef?.providerID && fallbackRef?.id) {
      const match = modelCatalog.find(
        (m) => m?.providerID === fallbackRef.providerID && m?.id === fallbackRef.id && m?.status !== "deprecated",
      )
      if (match?.limit?.context && match.limit.context > 0) return match.limit.context
    }
    return 200_000
  }

  let turnIndex = 0
  let currentUserPreview = "对话 #1"
  const turnBuckets = new Map<number, { preview: string; userTime: number; steps: StepStat[] }>()
  const stepStats: StepStat[] = []

  let lastCompactionIdx = -1
  let compacting = false

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!m) continue
    if (m.type === "compaction") {
      if (m.status === "running") compacting = true
      if (m.status === "completed") lastCompactionIdx = i
    }
  }

  let stepCounter = 0
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!m) continue
    if (m.type === "user" || m.type === "synthetic") {
      turnIndex++
      const rawText = typeof m.text === "string" ? m.text.trim().replace(/\s+/g, " ") : ""
      currentUserPreview = rawText ? (rawText.length > 36 ? rawText.slice(0, 36) + "…" : rawText) : `第 ${turnIndex} 轮提问`
      turnBuckets.set(turnIndex, {
        preview: currentUserPreview,
        userTime: Number(m.time?.created ?? now),
        steps: [],
      })
      continue
    }

    if (m.type === "assistant") {
      stepCounter++
      const activeTurn = turnIndex > 0 ? turnIndex : 1
      if (!turnBuckets.has(activeTurn)) {
        turnBuckets.set(activeTurn, {
          preview: currentUserPreview,
          userTime: Number(m.time?.created ?? now),
          steps: [],
        })
      }

      const tok = m.tokens
      const inTok = Number(tok?.input ?? 0)
      const outTok = Number(tok?.output ?? 0)
      const reasonTok = Number(tok?.reasoning ?? 0)
      const cacheRead = Number(tok?.cache?.read ?? 0)
      const cacheWrite = Number(tok?.cache?.write ?? 0)
      const promptTokens = inTok + cacheRead + cacheWrite
      const totalOut = outTok + reasonTok
      const totalTokens = promptTokens + totalOut
      const cacheRate = promptTokens > 0 ? Number(((cacheRead / promptTokens) * 100).toFixed(1)) : 0

      const createdMs = Number(m.time?.created ?? now)
      const firstTokenMs = m.time?.firstToken ? Number(m.time.firstToken) : undefined
      const streamedMs = m.time?.streamed ? Number(m.time.streamed) : undefined
      const completedMs = m.time?.completed ? Number(m.time.completed) : undefined
      const endMs = completedMs ?? streamedMs ?? now

      const ttftSec = firstTokenMs && firstTokenMs >= createdMs ? (firstTokenMs - createdMs) / 1000 : 0
      const streamStartMs = firstTokenMs ?? createdMs
      const streamEndMs = streamedMs ?? completedMs
      const streamSec = streamEndMs && streamEndMs >= streamStartMs ? (streamEndMs - streamStartMs) / 1000 : 0
      const totalSec = endMs >= createdMs ? (endMs - createdMs) / 1000 : 0

      const streamTps = streamSec >= 0.08 && totalOut > 0 ? totalOut / streamSec : 0
      const e2eTps = totalSec >= 0.08 && totalOut > 0 ? totalOut / totalSec : 0
      const displayTps = streamTps > 0 && streamTps <= 3000 ? streamTps : e2eTps

      const stat: StepStat = {
        index: stepCounter,
        id: String(m.id ?? `step_${stepCounter}`),
        turnIndex: activeTurn,
        modelID: String(m.model?.id ?? input.sessionInfo?.model?.id ?? "unknown"),
        providerID: String(m.model?.providerID ?? input.sessionInfo?.model?.providerID ?? ""),
        variant: m.model?.variant ?? input.sessionInfo?.model?.variant,
        agent: m.agent ?? input.sessionInfo?.agent,
        tokens: {
          input: inTok,
          output: outTok,
          reasoning: reasonTok,
          cacheRead,
          cacheWrite,
        },
        promptTokens,
        totalTokens,
        cacheRate,
        ttftSec: Number(ttftSec.toFixed(2)),
        streamSec: Number(streamSec.toFixed(2)),
        totalSec: Number(totalSec.toFixed(2)),
        streamTps: Number(streamTps.toFixed(1)),
        e2eTps: Number(e2eTps.toFixed(1)),
        displayTps: Number(displayTps.toFixed(1)),
        cost: Number(m.cost ?? 0),
        finish: m.finish,
        hasError: Boolean(m.error || m.finish === "error"),
        isRetrying: Boolean(m.retry),
        completed: completedMs !== undefined || tok !== undefined,
      }

      stepStats.push(stat)
      turnBuckets.get(activeTurn)!.steps.push(stat)
    }
  }

  // Active context step: latest assistant message with tokens after the last completed compaction
  let activeContextStep: StepStat | undefined
  for (let i = messages.length - 1; i > lastCompactionIdx; i--) {
    const m = messages[i]
    if (m?.type === "assistant" && m?.tokens !== undefined) {
      activeContextStep = stepStats.findLast((s) => s.id === m.id)
      break
    }
  }
  const compactedPending = lastCompactionIdx >= 0 && !activeContextStep

  const lastCompletedStep = stepStats.findLast((s) => s.promptTokens > 0 || s.tokens.output + s.tokens.reasoning > 0) ?? stepStats.at(-1)
  const latestAnyStep = stepStats.at(-1)

  const refModel = activeContextStep ?? lastCompletedStep ?? latestAnyStep
  const contextLimit = findContextLimit(refModel?.providerID, refModel?.modelID)
  const contextLimitLabel = fmtContextLimit(contextLimit)
  const contextTokens = activeContextStep ? activeContextStep.totalTokens : 0
  const contextRemainTokens = Math.max(0, contextLimit - contextTokens)
  const contextPct = contextLimit > 0 ? Math.min(100, Math.round((contextTokens / contextLimit) * 100)) : 0
  const contextLevel: "ok" | "warn" | "crit" | "compacted" = compactedPending
    ? "compacted"
    : contextPct >= 90
      ? "crit"
      : contextPct >= 75
        ? "warn"
        : "ok"

  // Build per-turn summaries
  const turns: TurnStat[] = []
  for (const [tIdx, bucket] of turnBuckets.entries()) {
    if (bucket.steps.length === 0) continue
    let inSum = 0
    let outSum = 0
    let reasonSum = 0
    let cacheReadSum = 0
    let cacheWriteSum = 0
    let streamSecSum = 0
    let totalSecSum = 0
    let ttftFirst = bucket.steps[0]?.ttftSec ?? 0
    let costSum = 0
    const modelsUsed: string[] = []

    for (const st of bucket.steps) {
      inSum += st.tokens.input
      outSum += st.tokens.output
      reasonSum += st.tokens.reasoning
      cacheReadSum += st.tokens.cacheRead
      cacheWriteSum += st.tokens.cacheWrite
      streamSecSum += st.streamSec
      totalSecSum += st.totalSec
      costSum += st.cost
      const mLabel = st.variant ? `${st.modelID}#${st.variant}` : st.modelID
      if (mLabel && !modelsUsed.includes(mLabel)) modelsUsed.push(mLabel)
    }

    const lastSt = bucket.steps[bucket.steps.length - 1]!
    const tLim = findContextLimit(lastSt.providerID, lastSt.modelID)
    const promptTok = inSum + cacheReadSum + cacheWriteSum
    const totalOut = outSum + reasonSum
    const streamTps = streamSecSum >= 0.08 && totalOut > 0 ? totalOut / streamSecSum : 0
    const e2eTps = totalSecSum >= 0.08 && totalOut > 0 ? totalOut / totalSecSum : 0
    const displayTps = streamTps > 0 && streamTps <= 3000 ? streamTps : e2eTps
    const modelLabel =
      modelsUsed.length <= 1 ? (modelsUsed[0] ?? "model") : `${modelsUsed[0]} → ${modelsUsed[modelsUsed.length - 1]}`

    turns.push({
      turnIndex: tIdx,
      userPreview: bucket.preview,
      steps: bucket.steps.length,
      modelLabel,
      tokens: {
        input: inSum,
        output: outSum,
        reasoning: reasonSum,
        cacheRead: cacheReadSum,
        cacheWrite: cacheWriteSum,
      },
      promptTokens: promptTok,
      totalOutTokens: totalOut,
      lastContextTokens: lastSt.totalTokens,
      contextLimit: tLim,
      contextPct: tLim > 0 ? Math.min(100, Math.round((lastSt.totalTokens / tLim) * 100)) : 0,
      cacheRate: promptTok > 0 ? Number(((cacheReadSum / promptTok) * 100).toFixed(1)) : 0,
      ttftSec: Number(ttftFirst.toFixed(2)),
      streamSec: Number(streamSecSum.toFixed(2)),
      totalSec: Number(totalSecSum.toFixed(2)),
      streamTps: Number(streamTps.toFixed(1)),
      e2eTps: Number(e2eTps.toFixed(1)),
      displayTps: Number(displayTps.toFixed(1)),
      cost: costSum,
    })
  }

  // Session cumulative totals
  const sessTok = input.sessionInfo?.tokens
  let totIn = 0
  let totOut = 0
  let totReason = 0
  let totCacheRead = 0
  let totCacheWrite = 0
  let totStreamSec = 0
  let totDurSec = 0
  let totCost = 0

  for (const st of stepStats) {
    totIn += st.tokens.input
    totOut += st.tokens.output
    totReason += st.tokens.reasoning
    totCacheRead += st.tokens.cacheRead
    totCacheWrite += st.tokens.cacheWrite
    totStreamSec += st.streamSec
    totDurSec += st.totalSec
    totCost += st.cost
  }

  // Prefer server's canonical session totals when higher
  if (sessTok) {
    totIn = Math.max(totIn, Number(sessTok.input ?? 0))
    totOut = Math.max(totOut, Number(sessTok.output ?? 0))
    totReason = Math.max(totReason, Number(sessTok.reasoning ?? 0))
    totCacheRead = Math.max(totCacheRead, Number(sessTok.cache?.read ?? 0))
    totCacheWrite = Math.max(totCacheWrite, Number(sessTok.cache?.write ?? 0))
  }
  const totPrompt = totIn + totCacheRead + totCacheWrite
  const totAllOut = totOut + totReason
  const sessionCacheRate = totPrompt > 0 ? Number(((totCacheRead / totPrompt) * 100).toFixed(1)) : 0
  const avgStreamTps = totStreamSec >= 0.08 && totAllOut > 0 ? Number((totAllOut / totStreamSec).toFixed(1)) : 0
  const avgE2eTps = totDurSec >= 0.08 && totAllOut > 0 ? Number((totAllOut / totDurSec).toFixed(1)) : 0

  // 4-state status machine
  const isRunning = input.sessionStatus === "running" || compacting
  const isRetrying = Boolean(latestAnyStep?.isRetrying)
  const hasError = Boolean(latestAnyStep?.hasError) && !isRunning
  const waitingLong =
    isRunning &&
    latestAnyStep &&
    !latestAnyStep.completed &&
    now - Number(messages.at(-1)?.time?.created ?? now) >= 45_000

  let status: TelemetryStatus = "ready"
  let statusLabel = "就绪"
  if (hasError) {
    status = "error"
    statusLabel = "执行异常"
  } else if (isRetrying || waitingLong) {
    status = "waiting"
    statusLabel = isRetrying ? "重试连接中…" : "长耗时等待…"
  } else if (compacting) {
    status = "running"
    statusLabel = "上下文压缩中…"
  } else if (isRunning) {
    status = "running"
    statusLabel = "正在生成…"
  }

  return {
    status,
    statusLabel,
    compacting,
    compactedPending,
    lastError: hasError ? "步骤执行异常" : undefined,
    userTurnCount: Math.max(turnIndex, turns.length),
    assistantStepCount: stepStats.filter((s) => s.promptTokens > 0 || s.tokens.output + s.tokens.reasoning > 0).length,
    contextTokens,
    contextLimit,
    contextLimitLabel,
    contextRemainTokens,
    contextPct,
    contextLevel,
    lastStep: lastCompletedStep,
    lastTurn: turns.at(-1),
    turns,
    totals: {
      input: totIn,
      output: totOut,
      reasoning: totReason,
      cacheRead: totCacheRead,
      cacheWrite: totCacheWrite,
      promptTokens: totPrompt,
      totalOutTokens: totAllOut,
      sessionCacheRate,
      avgStreamTps,
      avgE2eTps,
      totalDurationSec: Number(totDurSec.toFixed(1)),
      cost: input.sessionCost ?? Number(input.sessionInfo?.cost ?? totCost),
    },
    go: parseGoLimits(input.limitsInfo, now),
  }
}
