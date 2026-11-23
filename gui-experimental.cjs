"use strict";

const { Schema } = require("effect");
const {
  Command,
  ComposerPill,
  MenuItem,
  Panel,
  Plugin,
  SettingsPage,
  Slot,
  Store,
  Style,
  createKeyed,
  usePlugin,
} = require("@opencode/plugin/gui");
const {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
} = require("solid-js");
const {
  createComponent: _$createComponent,
  delegateEvents: _$delegateEvents,
  effect: _$effect,
  insert: _$insert,
  setAttribute: _$setAttribute,
  setStyleProperty: _$setStyleProperty,
  template: _$template,
} = require("solid-js/web");

// ─────────────────────── Metrics Calculation Engine ───────────────────────

function fmtTok(n) {
  if (!n || n <= 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (n >= 10_000) return Math.round(n / 1_000) + "k";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}

function fmtNum(n) {
  return Math.round(n || 0).toLocaleString("en-US");
}

function fmtContextLimit(tokens) {
  if (!tokens || tokens <= 0) return "200k";
  if (tokens >= 1_000_000) {
    if (tokens === 1_000_000 || tokens === 1_048_576) return "1M";
    return (tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, "") + "M";
  }
  return Math.round(tokens / 1_000) + "k";
}

function fmtDurationUntil(resetsAtMs, now = Date.now()) {
  if (!resetsAtMs || resetsAtMs <= now) return "即将重置";
  const diffMin = Math.max(1, Math.floor((resetsAtMs - now) / 60_000));
  const days = Math.floor(diffMin / 1440);
  const hours = Math.floor((diffMin % 1440) / 60);
  const mins = diffMin % 60;
  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${mins}分`;
  return `${mins}分钟`;
}

function computeSegPcts(values, targetTotalPct = 100, minVisiblePct = 2) {
  const sum = values.reduce((acc, v) => acc + (v > 0 ? v : 0), 0);
  const clamped = Math.max(0, Math.min(100, targetTotalPct));
  if (sum <= 0 || clamped <= 0) return values.map(() => 0);
  const raw = values.map((v) => (v > 0 ? (v / sum) * clamped : 0));
  const nonZero = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] > 0) nonZero.push(i);
  }
  if (nonZero.length > 1 && clamped > minVisiblePct * nonZero.length) {
    let deficit = 0;
    let flexSum = 0;
    for (const idx of nonZero) {
      if (raw[idx] < minVisiblePct) {
        deficit += minVisiblePct - raw[idx];
        raw[idx] = minVisiblePct;
      } else {
        flexSum += raw[idx] - minVisiblePct;
      }
    }
    if (deficit > 0 && flexSum > 0) {
      const ratio = Math.min(1, deficit / flexSum);
      for (const idx of nonZero) {
        if (raw[idx] > minVisiblePct) {
          raw[idx] -= (raw[idx] - minVisiblePct) * ratio;
        }
      }
    }
  }
  return raw.map((pct) => Number(pct.toFixed(1)));
}

function parseGoLimits(limitsInfo, now = Date.now()) {
  const go = limitsInfo?.go;
  if (!go) return undefined;
  const mk = (m) => ({
    percent: Math.round(Number(m?.percent ?? 0)),
    limited: Boolean(m?.limited || m?.status === "rate-limited" || Number(m?.percent ?? 0) >= 100),
    resetsAt: Number(m?.resetsAt ?? 0),
    resetsInLabel: fmtDurationUntil(Number(m?.resetsAt ?? 0), now),
  });
  return {
    workspaceName: limitsInfo?.workspace?.name,
    usageURL: limitsInfo?.workspace?.usageURL,
    rolling: mk(go.rolling),
    weekly: mk(go.weekly),
    monthly: mk(go.monthly),
  };
}

function computeSessionTelemetry(input) {
  const now = input.now ?? Date.now();
  const allMessages = input.messages ?? [];
  const revertID = input.sessionInfo?.revert?.messageID;
  const boundaryIdx = revertID ? allMessages.findIndex((m) => m?.id === revertID) : -1;
  const messages = boundaryIdx >= 0 ? allMessages.slice(0, boundaryIdx) : allMessages;

  const modelCatalog = input.models ?? [];
  const findContextLimit = (providerID, modelID) => {
    if (providerID && modelID) {
      const match = modelCatalog.find(
        (m) => m?.providerID === providerID && m?.id === modelID && m?.status !== "deprecated"
      );
      if (match?.limit?.context && match.limit.context > 0) return match.limit.context;
    }
    const fallbackRef = input.sessionInfo?.model;
    if (fallbackRef?.providerID && fallbackRef?.id) {
      const match = modelCatalog.find(
        (m) =>
          m?.providerID === fallbackRef.providerID &&
          m?.id === fallbackRef.id &&
          m?.status !== "deprecated"
      );
      if (match?.limit?.context && match.limit.context > 0) return match.limit.context;
    }
    return 200_000;
  };

  let turnIndex = 0;
  let currentUserPreview = "对话 #1";
  const turnBuckets = new Map();
  const stepStats = [];

  let lastCompactionIdx = -1;
  let compacting = false;
  let compactSummaryKb = 0;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.type === "compaction") {
      if (m.status === "running") compacting = true;
      if (m.status === "completed") {
        lastCompactionIdx = i;
        if (typeof m.summary === "string" && m.summary.length > 0) {
          compactSummaryKb = Number((m.summary.length / 1024).toFixed(1));
        }
      }
    }
  }

  let stepCounter = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.type === "user" || m.type === "synthetic") {
      turnIndex++;
      const rawText = typeof m.text === "string" ? m.text.trim().replace(/\s+/g, " ") : "";
      currentUserPreview = rawText
        ? rawText.length > 42
          ? rawText.slice(0, 42) + "…"
          : rawText
        : `第 ${turnIndex} 轮提问`;
      turnBuckets.set(turnIndex, {
        preview: currentUserPreview,
        userTime: Number(m.time?.created ?? now),
        steps: [],
      });
      continue;
    }

    if (m.type === "assistant") {
      stepCounter++;
      const activeTurn = turnIndex > 0 ? turnIndex : 1;
      if (!turnBuckets.has(activeTurn)) {
        turnBuckets.set(activeTurn, {
          preview: currentUserPreview,
          userTime: Number(m.time?.created ?? now),
          steps: [],
        });
      }

      const tok = m.tokens;
      const inTok = Number(tok?.input ?? 0);
      const outTok = Number(tok?.output ?? 0);
      const reasonTok = Number(tok?.reasoning ?? 0);
      const cacheRead = Number(tok?.cache?.read ?? 0);
      const cacheWrite = Number(tok?.cache?.write ?? 0);
      const promptTokens = inTok + cacheRead + cacheWrite;
      const totalOut = outTok + reasonTok;
      const totalTokens = promptTokens + totalOut;
      const cacheRate = promptTokens > 0 ? Number(((cacheRead / promptTokens) * 100).toFixed(1)) : 0;

      const createdMs = Number(m.time?.created ?? now);
      const firstTokenMs = m.time?.firstToken ? Number(m.time.firstToken) : undefined;
      const streamedMs = m.time?.streamed ? Number(m.time.streamed) : undefined;
      const completedMs = m.time?.completed ? Number(m.time.completed) : undefined;
      const endMs = completedMs ?? streamedMs ?? now;

      const ttftSec = firstTokenMs && firstTokenMs >= createdMs ? (firstTokenMs - createdMs) / 1000 : 0;
      const streamStartMs = firstTokenMs ?? createdMs;
      const streamEndMs = streamedMs ?? completedMs;
      const streamSec =
        streamEndMs && streamEndMs >= streamStartMs ? (streamEndMs - streamStartMs) / 1000 : 0;
      const totalSec = endMs >= createdMs ? (endMs - createdMs) / 1000 : 0;

      const streamTps = streamSec >= 0.08 && totalOut > 0 ? totalOut / streamSec : 0;
      const e2eTps = totalSec >= 0.08 && totalOut > 0 ? totalOut / totalSec : 0;
      const displayTps = streamTps > 0 && streamTps <= 3000 ? streamTps : e2eTps;

      let toolCount = 0;
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p?.type === "tool") toolCount++;
        }
      }

      const stat = {
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
        toolCount,
        finish: m.finish,
        hasError: Boolean(m.error || m.finish === "error"),
        isRetrying: Boolean(m.retry),
        completed: completedMs !== undefined || tok !== undefined,
      };

      stepStats.push(stat);
      turnBuckets.get(activeTurn).steps.push(stat);
    }
  }

  let activeContextStep = undefined;
  for (let i = messages.length - 1; i > lastCompactionIdx; i--) {
    const m = messages[i];
    if (m?.type === "assistant" && m?.tokens !== undefined) {
      activeContextStep = stepStats.findLast((s) => s.id === m.id);
      break;
    }
  }
  const compactedPending = lastCompactionIdx >= 0 && !activeContextStep;

  const lastCompletedStep =
    stepStats.findLast((s) => s.promptTokens > 0 || s.tokens.output + s.tokens.reasoning > 0) ??
    stepStats.at(-1);
  const latestAnyStep = stepStats.at(-1);

  const refModel = activeContextStep ?? lastCompletedStep ?? latestAnyStep;
  const contextLimit = findContextLimit(refModel?.providerID, refModel?.modelID);
  const contextLimitLabel = fmtContextLimit(contextLimit);
  const contextTokens = activeContextStep ? activeContextStep.totalTokens : 0;
  const contextRemainTokens = Math.max(0, contextLimit - contextTokens);
  const contextPct =
    contextLimit > 0 ? Math.min(100, Math.round((contextTokens / contextLimit) * 100)) : 0;
  const contextLevel = compactedPending
    ? "compacted"
    : contextPct >= 90
      ? "crit"
      : contextPct >= 75
        ? "warn"
        : "ok";

  const turns = [];
  for (const [tIdx, bucket] of turnBuckets.entries()) {
    if (bucket.steps.length === 0) continue;
    let inSum = 0;
    let outSum = 0;
    let reasonSum = 0;
    let cacheReadSum = 0;
    let cacheWriteSum = 0;
    let streamSecSum = 0;
    let totalSecSum = 0;
    let ttftFirst = bucket.steps[0]?.ttftSec ?? 0;
    let costSum = 0;
    let toolsSum = 0;
    const modelsUsed = [];

    for (const st of bucket.steps) {
      inSum += st.tokens.input;
      outSum += st.tokens.output;
      reasonSum += st.tokens.reasoning;
      cacheReadSum += st.tokens.cacheRead;
      cacheWriteSum += st.tokens.cacheWrite;
      streamSecSum += st.streamSec;
      totalSecSum += st.totalSec;
      costSum += st.cost;
      toolsSum += st.toolCount;
      const mLabel = st.variant ? `${st.modelID}#${st.variant}` : st.modelID;
      if (mLabel && !modelsUsed.includes(mLabel)) modelsUsed.push(mLabel);
    }

    const lastSt = bucket.steps[bucket.steps.length - 1];
    const tLim = findContextLimit(lastSt.providerID, lastSt.modelID);
    const promptTok = inSum + cacheReadSum + cacheWriteSum;
    const totalOut = outSum + reasonSum;
    const streamTps = streamSecSum >= 0.08 && totalOut > 0 ? totalOut / streamSecSum : 0;
    const e2eTps = totalSecSum >= 0.08 && totalOut > 0 ? totalOut / totalSecSum : 0;
    const displayTps = streamTps > 0 && streamTps <= 3000 ? streamTps : e2eTps;
    const modelLabel =
      modelsUsed.length <= 1
        ? modelsUsed[0] ?? "model"
        : `${modelsUsed[0]} → ${modelsUsed[modelsUsed.length - 1]}`;

    turns.push({
      turnIndex: tIdx,
      userPreview: bucket.preview,
      steps: bucket.steps.length,
      toolsCount: toolsSum,
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
      contextLimitLabel: fmtContextLimit(tLim),
      contextPct: tLim > 0 ? Math.min(100, Math.round((lastSt.totalTokens / tLim) * 100)) : 0,
      cacheRate: promptTok > 0 ? Number(((cacheReadSum / promptTok) * 100).toFixed(1)) : 0,
      ttftSec: Number(ttftFirst.toFixed(2)),
      streamSec: Number(streamSecSum.toFixed(2)),
      totalSec: Number(totalSecSum.toFixed(2)),
      streamTps: Number(streamTps.toFixed(1)),
      e2eTps: Number(e2eTps.toFixed(1)),
      displayTps: Number(displayTps.toFixed(1)),
      cost: costSum,
    });
  }

  const sessTok = input.sessionInfo?.tokens;
  let totIn = 0;
  let totOut = 0;
  let totReason = 0;
  let totCacheRead = 0;
  let totCacheWrite = 0;
  let totStreamSec = 0;
  let totDurSec = 0;
  let totCost = 0;

  for (const st of stepStats) {
    totIn += st.tokens.input;
    totOut += st.tokens.output;
    totReason += st.tokens.reasoning;
    totCacheRead += st.tokens.cacheRead;
    totCacheWrite += st.tokens.cacheWrite;
    totStreamSec += st.streamSec;
    totDurSec += st.totalSec;
    totCost += st.cost;
  }

  if (sessTok) {
    totIn = Math.max(totIn, Number(sessTok.input ?? 0));
    totOut = Math.max(totOut, Number(sessTok.output ?? 0));
    totReason = Math.max(totReason, Number(sessTok.reasoning ?? 0));
    totCacheRead = Math.max(totCacheRead, Number(sessTok.cache?.read ?? 0));
    totCacheWrite = Math.max(totCacheWrite, Number(sessTok.cache?.write ?? 0));
  }
  const totPrompt = totIn + totCacheRead + totCacheWrite;
  const totAllOut = totOut + totReason;
  const sessionCacheRate = totPrompt > 0 ? Number(((totCacheRead / totPrompt) * 100).toFixed(1)) : 0;
  const avgStreamTps =
    totStreamSec >= 0.08 && totAllOut > 0 ? Number((totAllOut / totStreamSec).toFixed(1)) : 0;
  const avgE2eTps =
    totDurSec >= 0.08 && totAllOut > 0 ? Number((totAllOut / totDurSec).toFixed(1)) : 0;

  const isRunning = input.sessionStatus === "running" || compacting;
  const isRetrying = Boolean(latestAnyStep?.isRetrying);
  const hasError = Boolean(latestAnyStep?.hasError) && !isRunning;
  const waitingLong =
    isRunning &&
    latestAnyStep &&
    !latestAnyStep.completed &&
    now - Number(messages.at(-1)?.time?.created ?? now) >= 45_000;

  let status = "ready";
  let statusLabel = "就绪";
  if (hasError) {
    status = "error";
    statusLabel = "执行异常";
  } else if (isRetrying || waitingLong) {
    status = "waiting";
    statusLabel = isRetrying ? "重试连接中…" : "长耗时等待…";
  } else if (compacting) {
    status = "running";
    statusLabel = "压缩中…";
  } else if (isRunning) {
    status = "running";
    statusLabel = "正在生成…";
  }

  return {
    status,
    statusLabel,
    compacting,
    compactedPending,
    compactSummaryKb,
    userTurnCount: Math.max(turnIndex, turns.length),
    assistantStepCount: stepStats.filter(
      (s) => s.promptTokens > 0 || s.tokens.output + s.tokens.reasoning > 0
    ).length,
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
  };
}

// ─────────────────────── Styles (Bento L1/L2 & Per-Turn Cards) ───────────────────────

const TELEMETRY_CSS = `
/* Remove OpenCode host's 260px truncation cap on our telemetry pill so detailed mode never cuts off */
[data-slot="session-plugin-pill"][aria-label*="Telemetry"] > span:not([data-composer-pill-icon]) {
  max-width: min(720px, calc(100vw - 140px)) !important;
}

/* Wider popover with bounded height so L2 and per-turn expansion never overflow off the top of the window */
[data-composer-pill-panel]:has(.oc-tt-wrap) {
  width: 440px !important;
  max-width: calc(100vw - 32px) !important;
  max-height: min(78vh, var(--kb-popper-content-available-height, 640px)) !important;
  padding: 0 !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
}

.oc-tt-wrap {
  font-family: var(--v2-font-family-sans, system-ui, -apple-system, sans-serif);
  color: var(--v2-text-text-base);
  display: flex;
  flex-direction: column;
  width: 100%;
  max-height: inherit;
  min-height: 0;
  font-size: 12px;
  line-height: 1.4;
  user-select: none;
}

.oc-tt-side-wrap {
  height: 100%;
  max-height: 100%;
}

.oc-tt-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 14px 8px;
  flex-shrink: 0;
  border-bottom: 0.5px solid var(--v2-border-border-base, rgba(128,128,128,0.12));
}

.oc-tt-body {
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
  overscroll-behavior: contain;
}

.oc-tt-hdr-left {
  font-weight: 600;
  font-size: 12.5px;
  color: var(--v2-text-text-base);
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.oc-tt-hdr-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.oc-tt-chip {
  font-size: 11px;
  font-weight: 530;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--v2-background-bg-layer-02, rgba(128,128,128,0.14));
  color: var(--v2-text-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.oc-tt-chip.is-running {
  background: rgba(43, 127, 255, 0.16);
  color: #3b82f6;
}
.oc-tt-chip.is-waiting {
  background: rgba(245, 158, 11, 0.16);
  color: #f59e0b;
}
.oc-tt-chip.is-error {
  background: rgba(239, 68, 68, 0.16);
  color: #ef4444;
}
.oc-tt-bento {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
  flex-shrink: 0;
}
.oc-tt-cell {
  background: var(--v2-background-bg-layer-02, rgba(128,128,128,0.08));
  border: 0.5px solid var(--v2-border-border-base, rgba(128,128,128,0.16));
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.oc-tt-lbl {
  font-size: 11px;
  color: var(--v2-text-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.oc-tt-val-row {
  display: flex;
  align-items: baseline;
  gap: 3px;
  font-variant-numeric: tabular-nums;
}
.oc-tt-val {
  font-size: 15px;
  font-weight: 650;
  color: var(--v2-text-text-base);
}
.oc-tt-val.is-good {
  color: #10b981;
}
.oc-tt-val.is-warn {
  color: #f59e0b;
}
.oc-tt-val.is-crit {
  color: #ef4444;
}
.oc-tt-unit {
  font-size: 11px;
  color: var(--v2-text-text-muted);
}
.oc-tt-sub {
  font-size: 11px;
  color: var(--v2-text-text-faint, var(--v2-text-text-muted));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}
.oc-tt-bar-blk {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--v2-background-bg-layer-02, rgba(128,128,128,0.07));
  border: 0.5px solid var(--v2-border-border-base, rgba(128,128,128,0.14));
  flex-shrink: 0;
}
.oc-tt-bar-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
}
.oc-tt-bar-name {
  color: var(--v2-text-text-muted);
  font-weight: 500;
  white-space: nowrap;
}
.oc-tt-bar-meta {
  color: var(--v2-text-text-base);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.oc-tt-track {
  height: 6px;
  width: 100%;
  border-radius: 999px;
  background: var(--v2-background-bg-layer-04, rgba(128,128,128,0.18));
  overflow: hidden;
  display: flex;
  gap: 1px;
}
.oc-tt-seg {
  height: 100%;
  border-radius: 999px;
  transition: width 180ms ease;
}
.oc-tt-c-brand { background: #3b82f6; }
.oc-tt-c-emerald { background: #10b981; }
.oc-tt-c-indigo { background: #8b5cf6; }
.oc-tt-c-amber { background: #f59e0b; }
.oc-tt-c-danger { background: #ef4444; }
.oc-tt-c-slate { background: #64748b; }
.oc-tt-c-mist { background: #38bdf8; }
.oc-tt-legend {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  color: var(--v2-text-text-muted);
  font-variant-numeric: tabular-nums;
}
.oc-tt-legend-left {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.oc-tt-leg {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.oc-tt-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  display: inline-block;
  flex-shrink: 0;
}
.oc-tt-grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
  flex-shrink: 0;
}
.oc-tt-sec-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--v2-text-text-muted);
  padding-top: 2px;
  flex-shrink: 0;
}
.oc-tt-go-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.oc-tt-go-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.oc-tt-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 14px 10px;
  border-top: 0.5px solid var(--v2-border-border-base, rgba(128,128,128,0.16));
  font-size: 11px;
  color: var(--v2-text-text-muted);
  flex-shrink: 0;
  background: var(--v2-background-bg-layer-01);
}
.oc-tt-footer-meta {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
  min-width: 0;
}
.oc-tt-btn-row {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}
.oc-tt-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 530;
  white-space: nowrap;
  flex-shrink: 0;
  color: var(--v2-text-text-base);
  background: var(--v2-background-bg-layer-02, rgba(128,128,128,0.12));
  border: 0.5px solid var(--v2-border-border-base, rgba(128,128,128,0.2));
  cursor: pointer;
}
.oc-tt-btn:hover {
  background: var(--v2-background-bg-layer-03, rgba(128,128,128,0.22));
}
.oc-tt-turn-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}
.oc-tt-turn-card {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--v2-background-bg-layer-02, rgba(128,128,128,0.07));
  border: 0.5px solid var(--v2-border-border-base, rgba(128,128,128,0.15));
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.oc-tt-turn-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 11.5px;
}
.oc-tt-turn-title {
  font-weight: 600;
  color: var(--v2-text-text-base);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.oc-tt-turn-badges {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 11px;
  color: var(--v2-text-text-muted);
  font-variant-numeric: tabular-nums;
}
`;

// ─────────────────────── Custom Animated Status Icons ───────────────────────

const ICON_READY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none">
  <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.35"/>
  <circle cx="8" cy="8" r="3.4" fill="#3b82f6"/>
</svg>`;

const ICON_RUNNING = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none">
  <circle cx="8" cy="8" r="6" stroke="#3b82f6" stroke-width="1.5" stroke-opacity="0.45"/>
  <circle cx="8" cy="8" r="3.2" fill="#3b82f6">
    <animate attributeName="r" values="2.2;4.4;2.2" dur="1.4s" repeatCount="indefinite"/>
    <animate attributeName="opacity" values="1;0.45;1" dur="1.4s" repeatCount="indefinite"/>
  </circle>
</svg>`;

const ICON_WAITING = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none">
  <circle cx="8" cy="8" r="6" stroke="#f59e0b" stroke-width="1.5" stroke-opacity="0.45"/>
  <circle cx="8" cy="8" r="3.2" fill="#f59e0b">
    <animate attributeName="r" values="2.4;4.2;2.4" dur="1.8s" repeatCount="indefinite"/>
  </circle>
</svg>`;

const ICON_ERROR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none">
  <circle cx="8" cy="8" r="6" stroke="#ef4444" stroke-width="1.5" stroke-opacity="0.5"/>
  <circle cx="8" cy="8" r="3.4" fill="#ef4444"/>
</svg>`;

// ─────────────────────── DOM Helper for Clean Solid Rendering ───────────────────────

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null) continue;
      if (k === "class") {
        if (typeof v === "function") _$effect(() => (el.className = v() || ""));
        else el.className = v;
      } else if (k === "style") {
        if (typeof v === "function") _$effect(() => el.setAttribute("style", v() || ""));
        else el.setAttribute("style", v);
      } else if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (typeof v === "function") {
        _$effect(() => el.setAttribute(k, String(v())));
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    _$insert(el, child);
  }
  return el;
}

// ─────────────────────── Reactive Session Telemetry Hook ───────────────────────

function createSessionTelemetryMemo(getSession, getNow) {
  return createMemo(() => {
    const session = getSession();
    if (!session || !session.id) return undefined;
    const data = session.server?.data;
    if (!data) return undefined;

    const info = data.session.get(session.id);
    const messages = data.session.message.list(session.id) ?? [];
    const status = data.session.status(session.id);
    const cost = data.session.cost(session.id);
    const loc = session.location ?? (session.directory ? { directory: session.directory } : undefined);
    const models = loc ? data.location.model.list(loc) ?? [] : [];
    const limits = loc ? data.location.usage.limits(loc) : undefined;

    return computeSessionTelemetry({
      messages,
      sessionInfo: info,
      sessionStatus: status,
      sessionCost: cost,
      models,
      limitsInfo: limits,
      now: getNow(),
    });
  });
}

function ensureSessionCatalogAndLimits(session) {
  if (!session || !session.id) return;
  const data = session.server?.data;
  if (!data) return;
  const loc = session.location ?? (session.directory ? { directory: session.directory } : undefined);
  if (loc) {
    void data.location.model.sync(loc).catch(() => undefined);
    void data.location.provider.sync(loc).catch(() => undefined);
    void data.location.usage.sync(loc).catch(() => undefined);
  }
}

// ─────────────────────── Bento Panel View (Popover & Side Panel) ───────────────────────

function renderTelemetryBentoView(options) {
  const { ctx, getSession, sideMode = false, onClosePopover } = options;
  const [tick, setTick] = createSignal(Date.now());
  const [expandedL2, setExpandedL2] = createSignal(
    sideMode || Boolean(ctx.stores.prefs.value.defaultExpandL2)
  );
  const [showTurns, setShowTurns] = createSignal(sideMode);

  const timer = setInterval(() => setTick(Date.now()), 15_000);
  onCleanup(() => clearInterval(timer));

  const tel = createSessionTelemetryMemo(getSession, tick);

  const refreshAll = () => {
    const s = getSession();
    if (!s?.server?.data) return;
    const loc = s.location ?? (s.directory ? { directory: s.directory } : undefined);
    if (loc) {
      s.server.data.location.usage.invalidate(loc);
      void s.server.data.location.usage.sync(loc).catch(() => undefined);
    }
    setTick(Date.now());
  };

  ensureSessionCatalogAndLimits(getSession());

  return h(
    "div",
    { class: sideMode ? "oc-tt-wrap oc-tt-side-wrap" : "oc-tt-wrap" },
    () => {
      const t = tel();
      if (!t) {
        return h("div", { class: "oc-tt-body" }, h("div", { class: "oc-tt-sub" }, "正在加载会话统计数据…"));
      }

      const step = t.lastStep;
      const turn = t.lastTurn;
      const tot = t.totals;
      const go = t.go;

      const mainTps = step ? step.displayTps : tot.avgStreamTps;
      const e2eTps = step ? step.e2eTps : tot.avgE2eTps;
      const ctxValClass =
        t.contextLevel === "crit"
          ? "oc-tt-val is-crit"
          : t.contextLevel === "warn"
            ? "oc-tt-val is-warn"
            : "oc-tt-val";

      // Context segmented bar
      const ctxTargetPct =
        t.contextLimit > 0 ? Math.min(100, (t.contextTokens / t.contextLimit) * 100) : 0;
      const stepIn = step?.tokens.input ?? 0;
      const stepCW = step?.tokens.cacheWrite ?? 0;
      const stepCR = step?.tokens.cacheRead ?? 0;
      const ctxSegs = computeSegPcts([stepIn, stepCW, stepCR], ctxTargetPct, 1.8);

      // Step duration & output bars
      const durSegs = step ? computeSegPcts([step.ttftSec, step.streamSec], 100, 4) : [0, 0];
      const stepOutSegs = step
        ? computeSegPcts([step.tokens.reasoning, step.tokens.output], 100, 4)
        : [0, 0];

      // Cumulative input & output bars
      const totInSegs = computeSegPcts([tot.input, tot.cacheWrite, tot.cacheRead], 100, 2);
      const totOutSegs = computeSegPcts([tot.reasoning, tot.output], 100, 2);

      const chipClass =
        t.status === "error"
          ? "oc-tt-chip is-error"
          : t.status === "waiting"
            ? "oc-tt-chip is-waiting"
            : t.status === "running"
              ? "oc-tt-chip is-running"
              : "oc-tt-chip";

      return [
        // Fixed Header
        h(
          "div",
          { class: "oc-tt-hdr" },
          h("span", { class: "oc-tt-hdr-left" }, "本轮最新请求与用量统计"),
          h(
            "span",
            { class: "oc-tt-hdr-right" },
            h("span", { class: chipClass }, t.statusLabel),
            h("span", { class: "oc-tt-chip" }, `Gen #${t.assistantStepCount}`)
          )
        ),

        // Scrollable Body (keeps top visible when L2 or Per-Turn expands)
        h(
          "div",
          { class: "oc-tt-body" },

          // L1 3-cell Bento Grid
          h(
            "div",
            { class: "oc-tt-bento" },
            // Cell 1: Speed
            h(
              "div",
              { class: "oc-tt-cell" },
              h("div", { class: "oc-tt-lbl" }, "生成速率"),
              h(
                "div",
                { class: "oc-tt-val-row" },
                h("span", { class: "oc-tt-val" }, mainTps.toFixed(1)),
                h("span", { class: "oc-tt-unit" }, "t/s")
              ),
              h("div", { class: "oc-tt-sub" }, `端到端 ${e2eTps.toFixed(1)} · ${(step?.ttftSec ?? 0).toFixed(1)}s`)
            ),
            // Cell 2: Context
            h(
              "div",
              { class: "oc-tt-cell" },
              h("div", { class: "oc-tt-lbl" }, "上下文容量"),
              h(
                "div",
                { class: "oc-tt-val-row" },
                h("span", { class: ctxValClass }, t.compactedPending ? "已压缩" : `${t.contextPct}%`)
              ),
              h(
                "div",
                { class: "oc-tt-sub" },
                t.compactedPending
                  ? `摘要 ${t.compactSummaryKb || 0} KB`
                  : `余 ${fmtTok(t.contextRemainTokens)} / ${t.contextLimitLabel}`
              )
            ),
            // Cell 3: Cache Hit Rate
            h(
              "div",
              { class: "oc-tt-cell" },
              h("div", { class: "oc-tt-lbl" }, "累计缓存命中"),
              h(
                "div",
                { class: "oc-tt-val-row" },
                h(
                  "span",
                  { class: tot.sessionCacheRate > 0 ? "oc-tt-val is-good" : "oc-tt-val" },
                  `${tot.sessionCacheRate}%`
                )
              ),
              h("div", { class: "oc-tt-sub" }, `本步 ${step?.cacheRate ?? 0}%`)
            )
          ),

          // L1 Current Context Segmented Bar
          h(
            "div",
            { class: "oc-tt-bar-blk" },
            h(
              "div",
              { class: "oc-tt-bar-top" },
              h("span", { class: "oc-tt-bar-name" }, "当前上下文构成"),
              h(
                "span",
                { class: "oc-tt-bar-meta" },
                t.compactedPending
                  ? "已完成对话压缩"
                  : `${fmtNum(t.contextTokens)} / ${t.contextLimitLabel}`
              )
            ),
            h(
              "div",
              { class: "oc-tt-track" },
              h("div", { class: "oc-tt-seg oc-tt-c-mist", style: `width:${ctxSegs[0]}%` }),
              stepCW > 0
                ? h("div", { class: "oc-tt-seg oc-tt-c-slate", style: `width:${ctxSegs[1]}%` })
                : null,
              h("div", { class: "oc-tt-seg oc-tt-c-emerald", style: `width:${ctxSegs[2]}%` })
            ),
            h(
              "div",
              { class: "oc-tt-legend" },
              h(
                "span",
                { class: "oc-tt-legend-left" },
                h(
                  "span",
                  { class: "oc-tt-leg" },
                  h("span", { class: "oc-tt-dot oc-tt-c-mist" }),
                  `新增 ${fmtNum(stepIn)}`
                ),
                stepCW > 0
                  ? h(
                      "span",
                      { class: "oc-tt-leg" },
                      h("span", { class: "oc-tt-dot oc-tt-c-slate" }),
                      `写缓存 ${fmtNum(stepCW)}`
                    )
                  : null,
                h(
                  "span",
                  { class: "oc-tt-leg" },
                  h("span", { class: "oc-tt-dot oc-tt-c-emerald" }),
                  `读缓存 ${fmtNum(stepCR)} (${step?.cacheRate ?? 0}%)`
                )
              ),
              h("span", { class: "oc-tt-leg" }, `余 ${fmtTok(t.contextRemainTokens)}`)
            )
          ),

          // OpenCode Go Allowance Section
          go
            ? h(
                "div",
                { class: "oc-tt-bar-blk" },
                h(
                  "div",
                  { class: "oc-tt-bar-top" },
                  h("span", { class: "oc-tt-bar-name" }, `OpenCode Go 额度 (${go.workspaceName || "Default"})`),
                  go.usageURL
                    ? h(
                        "span",
                        {
                          class: "oc-tt-leg",
                          style: "cursor:pointer;color:#3b82f6",
                          onClick: () => ctx.system.openExternal(go.usageURL),
                        },
                        "Console ↗"
                      )
                    : null
                ),
                h(
                  "div",
                  { class: "oc-tt-go-grid" },
                  ...[
                    { label: "5小时窗口", meter: go.rolling },
                    { label: "本周额度", meter: go.weekly },
                    { label: "本月额度", meter: go.monthly },
                  ].map((item) => {
                    const barColor = item.meter.limited
                      ? "oc-tt-c-danger"
                      : item.meter.percent >= 80
                        ? "oc-tt-c-amber"
                        : "oc-tt-c-brand";
                    return h(
                      "div",
                      { class: "oc-tt-go-row" },
                      h(
                        "div",
                        { class: "oc-tt-legend" },
                        h("span", null, item.label),
                        h(
                          "span",
                          null,
                          `${item.meter.percent}% 已用 · ${item.meter.resetsInLabel}后重置`
                        )
                      ),
                      h(
                        "div",
                        { class: "oc-tt-track" },
                        h("div", {
                          class: `oc-tt-seg ${barColor}`,
                          style: `width:${Math.max(0, Math.min(100, item.meter.percent))}%`,
                        })
                      )
                    );
                  })
                )
              )
            : null,

          // L2 Detailed Breakdown
          ...(expandedL2()
            ? [
                h(
                  "div",
                  { class: "oc-tt-grid-2" },
                  h(
                    "div",
                    { class: "oc-tt-bar-blk" },
                    h(
                      "div",
                      { class: "oc-tt-bar-top" },
                      h("span", { class: "oc-tt-bar-name" }, "响应耗时"),
                      h("span", { class: "oc-tt-bar-meta" }, `${(step?.totalSec ?? 0).toFixed(2)}s`)
                    ),
                    h(
                      "div",
                      { class: "oc-tt-track" },
                      h("div", { class: "oc-tt-seg oc-tt-c-slate", style: `width:${durSegs[0]}%` }),
                      h("div", { class: "oc-tt-seg oc-tt-c-brand", style: `width:${durSegs[1]}%` })
                    ),
                    h(
                      "div",
                      { class: "oc-tt-legend" },
                      h(
                        "span",
                        { class: "oc-tt-leg" },
                        h("span", { class: "oc-tt-dot oc-tt-c-slate" }),
                        `TTFT ${(step?.ttftSec ?? 0).toFixed(2)}s`
                      ),
                      h(
                        "span",
                        { class: "oc-tt-leg" },
                        h("span", { class: "oc-tt-dot oc-tt-c-brand" }),
                        `流式 ${(step?.streamSec ?? 0).toFixed(2)}s`
                      )
                    )
                  ),
                  h(
                    "div",
                    { class: "oc-tt-bar-blk" },
                    h(
                      "div",
                      { class: "oc-tt-bar-top" },
                      h("span", { class: "oc-tt-bar-name" }, "本步输出"),
                      h(
                        "span",
                        { class: "oc-tt-bar-meta" },
                        fmtNum((step?.tokens.output ?? 0) + (step?.tokens.reasoning ?? 0))
                      )
                    ),
                    h(
                      "div",
                      { class: "oc-tt-track" },
                      h("div", { class: "oc-tt-seg oc-tt-c-indigo", style: `width:${stepOutSegs[0]}%` }),
                      h("div", { class: "oc-tt-seg oc-tt-c-brand", style: `width:${stepOutSegs[1]}%` })
                    ),
                    h(
                      "div",
                      { class: "oc-tt-legend" },
                      h(
                        "span",
                        { class: "oc-tt-leg" },
                        h("span", { class: "oc-tt-dot oc-tt-c-indigo" }),
                        `思考 ${fmtNum(step?.tokens.reasoning)}`
                      ),
                      h(
                        "span",
                        { class: "oc-tt-leg" },
                        h("span", { class: "oc-tt-dot oc-tt-c-brand" }),
                        `正文 ${fmtNum(step?.tokens.output)}`
                      )
                    )
                  )
                ),

                turn && turn.steps > 1
                  ? (() => {
                      const turnSegs = computeSegPcts(
                        [turn.tokens.reasoning, turn.tokens.output],
                        100,
                        3
                      );
                      return h(
                        "div",
                        { class: "oc-tt-bar-blk" },
                        h(
                          "div",
                          { class: "oc-tt-bar-top" },
                          h(
                            "span",
                            { class: "oc-tt-bar-name" },
                            `本轮合计（${turn.steps}步 · 耗时 ${turn.totalSec.toFixed(1)}s）`
                          ),
                          h("span", { class: "oc-tt-bar-meta" }, `输出 ${fmtNum(turn.totalOutTokens)}`)
                        ),
                        h(
                          "div",
                          { class: "oc-tt-track" },
                          h("div", { class: "oc-tt-seg oc-tt-c-indigo", style: `width:${turnSegs[0]}%` }),
                          h("div", { class: "oc-tt-seg oc-tt-c-brand", style: `width:${turnSegs[1]}%` })
                        ),
                        h(
                          "div",
                          { class: "oc-tt-legend" },
                          h(
                            "span",
                            { class: "oc-tt-legend-left" },
                            h(
                              "span",
                              { class: "oc-tt-leg" },
                              h("span", { class: "oc-tt-dot oc-tt-c-indigo" }),
                              `思考 ${fmtNum(turn.tokens.reasoning)}`
                            ),
                            h(
                              "span",
                              { class: "oc-tt-leg" },
                              h("span", { class: "oc-tt-dot oc-tt-c-brand" }),
                              `回应 ${fmtNum(turn.tokens.output)}`
                            )
                          ),
                          h("span", { class: "oc-tt-leg" }, `缓存命中 ${turn.cacheRate}%`)
                        )
                      );
                    })()
                  : null,

                h(
                  "div",
                  { class: "oc-tt-sec-hdr" },
                  h("span", null, "当前会话累计"),
                  h(
                    "span",
                    { class: "oc-tt-chip" },
                    `${t.userTurnCount} 轮提问 / ${t.assistantStepCount} 次模型请求`
                  )
                ),

                h(
                  "div",
                  { class: "oc-tt-bar-blk" },
                  h(
                    "div",
                    { class: "oc-tt-bar-top" },
                    h("span", { class: "oc-tt-bar-name" }, "累计输入量"),
                    h(
                      "span",
                      { class: "oc-tt-bar-meta" },
                      `总 ${fmtTok(tot.promptTokens)} · 命中率 ${tot.sessionCacheRate}%`
                    )
                  ),
                  h(
                    "div",
                    { class: "oc-tt-track" },
                    h("div", { class: "oc-tt-seg oc-tt-c-mist", style: `width:${totInSegs[0]}%` }),
                    tot.cacheWrite > 0
                      ? h("div", { class: "oc-tt-seg oc-tt-c-slate", style: `width:${totInSegs[1]}%` })
                      : null,
                    h("div", { class: "oc-tt-seg oc-tt-c-emerald", style: `width:${totInSegs[2]}%` })
                  ),
                  h(
                    "div",
                    { class: "oc-tt-legend" },
                    h(
                      "span",
                      { class: "oc-tt-legend-left" },
                      h(
                        "span",
                        { class: "oc-tt-leg" },
                        h("span", { class: "oc-tt-dot oc-tt-c-mist" }),
                        `新增 ${fmtTok(tot.input)}`
                      ),
                      tot.cacheWrite > 0
                        ? h(
                            "span",
                            { class: "oc-tt-leg" },
                            h("span", { class: "oc-tt-dot oc-tt-c-slate" }),
                            `写缓存 ${fmtTok(tot.cacheWrite)}`
                          )
                        : null,
                      h(
                        "span",
                        { class: "oc-tt-leg" },
                        h("span", { class: "oc-tt-dot oc-tt-c-emerald" }),
                        `缓存读取 ${fmtTok(tot.cacheRead)}`
                      )
                    )
                  )
                ),

                h(
                  "div",
                  { class: "oc-tt-bar-blk" },
                  h(
                    "div",
                    { class: "oc-tt-bar-top" },
                    h("span", { class: "oc-tt-bar-name" }, "累计输出量"),
                    h("span", { class: "oc-tt-bar-meta" }, `总计 ${fmtTok(tot.totalOutTokens)}`)
                  ),
                  h(
                    "div",
                    { class: "oc-tt-track" },
                    h("div", { class: "oc-tt-seg oc-tt-c-indigo", style: `width:${totOutSegs[0]}%` }),
                    h("div", { class: "oc-tt-seg oc-tt-c-brand", style: `width:${totOutSegs[1]}%` })
                  ),
                  h(
                    "div",
                    { class: "oc-tt-legend" },
                    h(
                      "span",
                      { class: "oc-tt-legend-left" },
                      h(
                        "span",
                        { class: "oc-tt-leg" },
                        h("span", { class: "oc-tt-dot oc-tt-c-indigo" }),
                        `思考链 ${fmtTok(tot.reasoning)}`
                      ),
                      h(
                        "span",
                        { class: "oc-tt-leg" },
                        h("span", { class: "oc-tt-dot oc-tt-c-brand" }),
                        `正文/工具 ${fmtTok(tot.output)}`
                      )
                    )
                  )
                ),
              ]
            : []),

          // Per-Turn Breakdown List
          ...(showTurns() && t.turns.length > 0
            ? [
                h(
                  "div",
                  { class: "oc-tt-sec-hdr" },
                  h("span", null, "每轮对话尾部统计"),
                  h("span", { class: "oc-tt-chip" }, `共 ${t.turns.length} 轮`)
                ),
                h(
                  "div",
                  { class: "oc-tt-turn-list" },
                  ...t.turns
                    .slice(-12)
                    .toReversed()
                    .map((tr) =>
                      h(
                        "div",
                        { class: "oc-tt-turn-card" },
                        h(
                          "div",
                          { class: "oc-tt-turn-top" },
                          h("span", { class: "oc-tt-turn-title" }, `#${tr.turnIndex} ${tr.userPreview}`),
                          h("span", { class: "oc-tt-chip" }, tr.modelLabel)
                        ),
                        h(
                          "div",
                          { class: "oc-tt-turn-badges" },
                          h("span", null, `${Math.round(tr.displayTps)} t/s (端到端 ${tr.e2eTps} t/s)`),
                          h("span", null, "·"),
                          h("span", null, `Ctx ${fmtTok(tr.lastContextTokens)}/${tr.contextLimitLabel} (${tr.contextPct}%)`),
                          h("span", null, "·"),
                          h("span", null, `Cache ${tr.cacheRate}%`)
                        ),
                        h(
                          "div",
                          { class: "oc-tt-turn-badges" },
                          h(
                            "span",
                            null,
                            `In ${fmtTok(tr.promptTokens)} (新 ${fmtTok(tr.tokens.input)} / 读缓存 ${fmtTok(tr.tokens.cacheRead)})`
                          ),
                          h("span", null, "·"),
                          h(
                            "span",
                            null,
                            `Out ${fmtTok(tr.totalOutTokens)} (思考 ${fmtTok(tr.tokens.reasoning)} / 正文 ${fmtTok(tr.tokens.output)})`
                          ),
                          h("span", null, "·"),
                          h("span", null, `${tr.steps}步 / TTFT ${tr.ttftSec}s / 共 ${tr.totalSec}s`)
                        )
                      )
                    )
                ),
              ]
            : [])
        ),

        // Fixed Footer Controls (buttons never wrap)
        h(
          "div",
          { class: "oc-tt-footer" },
          h(
            "span",
            { class: "oc-tt-footer-meta" },
            `${t.userTurnCount}轮 · ${t.assistantStepCount}次 · ${tot.totalDurationSec}s`
          ),
          h(
            "div",
            { class: "oc-tt-btn-row" },
            h(
              "button",
              {
                type: "button",
                class: "oc-tt-btn",
                onClick: () => refreshAll(),
              },
              "刷新"
            ),
            h(
              "button",
              {
                type: "button",
                class: "oc-tt-btn",
                onClick: () => setShowTurns((v) => !v),
              },
              showTurns() ? "收起每轮" : "每轮明细"
            ),
            h(
              "button",
              {
                type: "button",
                class: "oc-tt-btn",
                onClick: () => setExpandedL2((v) => !v),
              },
              expandedL2() ? "收起明细 ▴" : "展开明细 ▾"
            ),
            !sideMode
              ? h(
                  "button",
                  {
                    type: "button",
                    class: "oc-tt-btn",
                    onClick: () => {
                      const s = getSession();
                      onClosePopover?.();
                      if (s) ctx.layout.open(`${ctx.id}:main`, s, { tab: "select" });
                    },
                  },
                  "侧栏"
                )
              : null
          )
        ),
      ];
    }
  );
}

// ─────────────────────── Plugin Definition ───────────────────────

const PrefsSchema = Schema.Struct({
  layout: Schema.Literal("compact", "detailed"),
  cacheMode: Schema.Literal("session", "step"),
  showGoInPill: Schema.Boolean,
  defaultExpandL2: Schema.Boolean,
});

const definition = Plugin.define({
  stores: {
    prefs: Store.global(PrefsSchema, {
      layout: "compact",
      cacheMode: "session",
      showGoInPill: true,
      defaultExpandL2: false,
    }),
  },
  icons: {
    ready: ICON_READY,
    running: ICON_RUNNING,
    waiting: ICON_WAITING,
    error: ICON_ERROR,
  },
  i18n: {
    en: {
      title: "Telemetry & Go Metrics",
      "panel.title": "Telemetry",
      "command.toggle": "Toggle Telemetry & Go Metrics Panel",
      "command.refresh": "Refresh OpenCode Go Allowance",
      "settings.title": "Telemetry & Metrics",
      "settings.description": "Configure live session status pill, L1/L2 Bento usage panels, cache hit rate mode, and OpenCode Go allowance display.",
    },
    zh: {
      title: "Telemetry 实时用量统计",
      "panel.title": "用量统计",
      "command.toggle": "打开/关闭 Telemetry 详细统计侧栏",
      "command.refresh": "刷新 OpenCode Go 额度",
      "settings.title": "实时统计 (Telemetry)",
      "settings.description": "配置输入框上方实时状态胶囊、一/二级 Bento 用量面板、缓存命中率口径以及 OpenCode Go 额度展示。",
    },
  },
  setup(ctx) {
    const [tick, setTick] = createSignal(Date.now());
    const timer = setInterval(() => setTick(Date.now()), 20_000);
    onCleanup(() => clearInterval(timer));

    // Auto-sync catalog and Go usage limits whenever a session is routed
    createKeyed(
      () => {
        const s = ctx.sessions.current();
        if (!s?.id || !s.server.connected) return undefined;
        return { session: s, key: s.key, dir: s.directory };
      },
      (target) => {
        ensureSessionCatalogAndLimits(target.session);
      },
      {
        equals: (a, b) => a.key === b.key && a.dir === b.dir,
      }
    );

    ctx.add(Style, TELEMETRY_CSS);

    // 1. Live Composer Pill above the prompt (4-state LED icon + metrics summary + L1/L2 Bento Popover)
    ctx.add(ComposerPill, {
      id: "metrics",
      order: -10,
      show: (input) => {
        ensureSessionCatalogAndLimits(input.session);
        const data = input.session.server?.data;
        if (!data || !input.session.id) return undefined;

        const info = data.session.get(input.session.id);
        const messages = data.session.message.list(input.session.id) ?? [];
        const status = data.session.status(input.session.id);
        const cost = data.session.cost(input.session.id);
        const loc =
          input.session.location ??
          (input.session.directory ? { directory: input.session.directory } : undefined);
        const models = loc ? data.location.model.list(loc) ?? [] : [];
        const limits = loc ? data.location.usage.limits(loc) : undefined;

        const t = computeSessionTelemetry({
          messages,
          sessionInfo: info,
          sessionStatus: status,
          sessionCost: cost,
          models,
          limitsInfo: limits,
          now: tick(),
        });

        const prefs = ctx.stores.prefs.value;
        const step = t.lastStep;
        const tps = Math.round(step?.displayTps ?? t.totals.avgStreamTps ?? 0);
        const cacheVal =
          prefs.cacheMode === "step" ? step?.cacheRate ?? 0 : t.totals.sessionCacheRate;
        const goPart =
          prefs.showGoInPill && t.go
            ? ` · Go ${t.go.rolling.percent}%/${t.go.monthly.percent}%`
            : "";

        let label;
        if (prefs.layout === "detailed") {
          const ttft = (step?.ttftSec ?? 0).toFixed(1);
          const ctxPart = t.compactedPending
            ? "Ctx 已压缩"
            : `Ctx ${fmtTok(t.contextTokens)}/${t.contextLimitLabel} (${t.contextPct}%)`;
          const outPart = fmtTok((step?.tokens.output ?? 0) + (step?.tokens.reasoning ?? 0));
          label = `${tps} tok/s · TTFT ${ttft}s · ${ctxPart} · Out ${outPart} · Cache ${cacheVal}%${goPart}`;
        } else {
          const ctxPart = t.compactedPending ? "Ctx 已压缩" : `Ctx ${t.contextPct}%`;
          label = `${tps} tok/s · ${ctxPart} · Cache ${cacheVal}%${goPart}`;
        }

        const iconMap = {
          ready: ctx.icons.ready,
          running: ctx.icons.running,
          waiting: ctx.icons.waiting,
          error: ctx.icons.error,
        };

        const tone =
          t.status === "error" || t.contextLevel === "crit"
            ? "danger"
            : t.status === "waiting" || t.contextLevel === "warn"
              ? "warning"
              : undefined;

        return {
          icon: iconMap[t.status] || ctx.icons.ready,
          label,
          tone,
          title: "Telemetry 实时会话统计与 OpenCode Go 额度",
        };
      },
      menu: (input) =>
        renderTelemetryBentoView({
          ctx,
          getSession: () => input.session,
          sideMode: false,
          onClosePopover: () => input.close(),
        }),
    });

    // 2. Side Panel for Pinned L1/L2 + Per-Turn History
    const mainTab = {
      id: "main",
      get title() {
        return "Telemetry 统计";
      },
      closable: "compact",
      fallback: false,
    };

    ctx.add(Panel, {
      id: "main",
      region: "side",
      width: 440,
      mobile: {
        get title() {
          return "Telemetry 统计";
        },
        order: 48,
        kind: "menu",
        icon: "status",
      },
      list: (input) => (input.open.includes("main") ? [mainTab] : []),
      render: (props) =>
        renderTelemetryBentoView({
          ctx,
          getSession: () => props.session,
          sideMode: true,
        }),
    });

    // 3. Side Panel + Menu Item Launcher
    ctx.add(MenuItem, () => {
      const session = ctx.sessions.current();
      return {
        menu: "session.panel",
        id: "open",
        title: "Telemetry 用量与每轮统计",
        icon: "status",
        keybind: `${ctx.id}.toggle`,
        opened: Boolean(session && ctx.layout.state(`${ctx.id}:main`, session) !== "closed"),
        run: () => {
          const s = ctx.sessions.current();
          if (s) ctx.layout.open(`${ctx.id}:main`, s, { tab: "select" });
        },
      };
    });

    // 4. Commands & Slash Commands (/metrics)
    ctx.add(Command, () => ({
      id: "toggle",
      title: "打开/关闭 Telemetry 详细会话统计与 Go 额度侧栏",
      keywords: "telemetry metrics cache usage opg go tokens",
      section: "session",
      bind: "mod+shift+m",
      slash: { name: "metrics" },
      featured: true,
      enabled: Boolean(ctx.sessions.current()),
      run: () => {
        const s = ctx.sessions.current();
        if (s) ctx.layout.toggle(`${ctx.id}:main`, s);
      },
    }));

    ctx.add(Command, () => ({
      id: "refresh",
      title: "刷新 OpenCode Go 额度与会话统计",
      keywords: "telemetry refresh go allowance quota",
      section: "session",
      enabled: Boolean(ctx.sessions.current()),
      run: () => {
        const s = ctx.sessions.current();
        if (!s?.server?.data) return;
        const loc = s.location ?? (s.directory ? { directory: s.directory } : undefined);
        if (loc) {
          s.server.data.location.usage.invalidate(loc);
          void s.server.data.location.usage.sync(loc).then(
            () => ctx.toast.show({ variant: "success", title: "OpenCode Go 额度已刷新" }),
            () => ctx.toast.show({ variant: "error", title: "刷新额度失败" })
          );
        }
      },
    }));

    // 5. Native Settings Page (Settings -> 实时统计 Telemetry)
    ctx.add(SettingsPage, {
      id: "telemetry",
      icon: "status",
      get title() {
        return "实时统计 (Telemetry)";
      },
      get entries() {
        return [
          { id: "layout", title: "状态胶囊密度", keywords: "compact detailed layout ttft" },
          { id: "cacheMode", title: "缓存命中率口径", keywords: "cache hit rate session step" },
          { id: "showGoInPill", title: "胶囊显示 OpenCode Go 额度", keywords: "opg go allowance quota" },
          { id: "defaultExpandL2", title: "默认展开二级明细面板", keywords: "l2 detail bento" },
        ];
      },
      render: () => {
        const ui = ctx.ui;
        const prefs = () => ctx.stores.prefs.value;

        return _$createComponent(ui.SettingsLayout, {
          title: "实时会话统计与 OpenCode Go 监控 (Telemetry)",
          description:
            "管理输入框上方的四态状态胶囊、一/二级 Bento 用量面板、每轮对话统计与 OpenCode Go 额度显示。",
          get children() {
            return _$createComponent(ui.SettingsSection, {
              title: "状态栏与指标口径",
              get children() {
                return [
                  _$createComponent(ui.SettingsRow, {
                    id: "layout",
                    title: "状态胶囊布局密度",
                    description:
                      "紧凑模式显示 tok/s · Ctx · Cache；详细模式额外显示 TTFT 首字延迟、精确上下文容量与 Out 输出量。",
                    get children() {
                      return _$createComponent(ui.Select, {
                        label: "状态胶囊布局密度",
                        options: [
                          { value: "compact", label: "紧凑 (Compact)" },
                          { value: "detailed", label: "详细 (Detailed)" },
                        ],
                        get value() {
                          return prefs().layout;
                        },
                        onChange: (val) => {
                          ctx.stores.prefs.update((d) => {
                            d.layout = val;
                          });
                        },
                      });
                    },
                  }),
                  _$createComponent(ui.SettingsRow, {
                    id: "cacheMode",
                    title: "胶囊缓存命中率口径",
                    description: "选择状态胶囊上显示的 Cache% 是会话累计命中率还是最新单步命中率。",
                    get children() {
                      return _$createComponent(ui.Select, {
                        label: "缓存命中率口径",
                        options: [
                          { value: "session", label: "会话累计命中率 (Session)" },
                          { value: "step", label: "单步命中率 (Step)" },
                        ],
                        get value() {
                          return prefs().cacheMode;
                        },
                        onChange: (val) => {
                          ctx.stores.prefs.update((d) => {
                            d.cacheMode = val;
                          });
                        },
                      });
                    },
                  }),
                  _$createComponent(ui.SettingsRow, {
                    id: "showGoInPill",
                    title: "在状态胶囊中显示 OpenCode Go 额度",
                    description: "开启后在胶囊末尾直接显示 Go 5小时窗口与月度已用百分比。",
                    get children() {
                      return _$createComponent(ui.Switch, {
                        label: "显示 Go 额度",
                        hideLabel: true,
                        get checked() {
                          return prefs().showGoInPill;
                        },
                        onChange: (checked) => {
                          ctx.stores.prefs.update((d) => {
                            d.showGoInPill = checked;
                          });
                        },
                      });
                    },
                  }),
                  _$createComponent(ui.SettingsRow, {
                    id: "defaultExpandL2",
                    title: "点击胶囊默认展开二级 (L2) 明细面板",
                    description: "开启后点击状态胶囊直接展示包含 TTFT、思考/正文拆分及累计输入输出的完整二级面板。",
                    get children() {
                      return _$createComponent(ui.Switch, {
                        label: "默认展开二级明细",
                        hideLabel: true,
                        get checked() {
                          return prefs().defaultExpandL2;
                        },
                        onChange: (checked) => {
                          ctx.stores.prefs.update((d) => {
                            d.defaultExpandL2 = checked;
                          });
                        },
                      });
                    },
                  }),
                ];
              },
            });
          },
        });
      },
    });
  },
});

module.exports = definition;
module.exports.default = definition;
