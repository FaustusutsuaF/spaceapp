/**
 * Workflow-side span observability. This module runs INSIDE the deterministic
 * workflow sandbox: it does no I/O. Spans leave the sandbox only through the
 * workerSpans sink (registered with callDuringReplay: false, so replay emits
 * nothing), and parent context travels through Temporal headers:
 *
 * - activities and child workflows get the workflow span as their parent
 *   (header kind "parent");
 * - a continue-as-new run links to the run it continues (header kind "link").
 *
 * Registered from the worker entrypoints through
 * WorkerOptions.interceptors.workflowModules; the module must export an
 * interceptors() factory.
 */

import {
  ContinueAsNew,
  isCancellation,
  proxySinks,
  workflowInfo,
  type ActivityInput,
  type ContinueAsNewInput,
  type Headers,
  type LocalActivityInput,
  type SignalInput,
  type StartChildWorkflowExecutionInput,
  type Sinks,
  type WorkflowExecuteInput,
  type WorkflowInterceptors,
  type WorkflowOutboundCallsInterceptor
} from "@temporalio/workflow";
import {
  SPAN_CONTEXT_HEADER,
  decodeSpanContextHeader,
  encodeSpanContextHeader,
  workflowSpanCorrelation,
  workflowSpanId,
  workflowTraceId,
  type WorkerSpanSinkDefinitions,
  type WorkflowSpanContextHeader,
  type WorkflowSpanEvent,
  type WorkflowSpanLink
} from "./workflow-span-context.js";

type WorkerSpanSinks = Sinks & WorkerSpanSinkDefinitions;

const { workerSpans } = proxySinks<WorkerSpanSinks>();

/** Temporal workflow interceptor factory that propagates span context and emits workflow spans. */
export function interceptors(): WorkflowInterceptors {
  // Resolved by inbound execute (and later handleSignal), which always runs
  // before any outbound call of the same activation. Pure function of the
  // workflow input, memo, and signal args, so replay reproduces identical headers.
  let current: { traceId: string; spanId: string } | null = null;
  let startedWithoutInputTraceparent = false;
  let spanParentId: string | null = null;
  let spanAttributes: Record<string, string | number> = {};

  const withParentHeader = (headers: Headers): Headers =>
    current
      ? { ...headers, [SPAN_CONTEXT_HEADER]: encodeSpanContextHeader({ ...current, kind: "parent" }) }
      : headers;

  const outbound: WorkflowOutboundCallsInterceptor = {
    scheduleActivity: (input: ActivityInput, next) => next({ ...input, headers: withParentHeader(input.headers) }),
    scheduleLocalActivity: (input: LocalActivityInput, next) => next({ ...input, headers: withParentHeader(input.headers) }),
    startChildWorkflowExecution: (input: StartChildWorkflowExecutionInput, next) => next({ ...input, headers: withParentHeader(input.headers) }),
    continueAsNew: (input: ContinueAsNewInput, next) =>
      next({
        ...input,
        headers: current
          ? { ...input.headers, [SPAN_CONTEXT_HEADER]: encodeSpanContextHeader({ ...current, kind: "link" }) }
          : input.headers
      })
  };

  const adoptSignalCorrelation = (args: readonly unknown[]): void => {
    if (!startedWithoutInputTraceparent) return;
    const correlation = workflowSpanCorrelation(args);
    if (correlation.traceparent && current) {
      current = { traceId: correlation.traceparent.traceId, spanId: current.spanId };
      spanParentId = correlation.traceparent.parentId;
    }
    for (const [key, value] of Object.entries(correlation.attributes)) spanAttributes[key] = value;
  };

  return {
    inbound: [
      {
        execute: async (input: WorkflowExecuteInput, next) => {
          const info = workflowInfo();
          const correlation = workflowSpanCorrelation(input.args, info.memo);
          const header: WorkflowSpanContextHeader | null = decodeSpanContextHeader(input.headers?.[SPAN_CONTEXT_HEADER]);
          const inputTrace = correlation.traceparent;
          const links: WorkflowSpanLink[] = [];
          let traceId: string;
          let parentSpanId: string | null;
          if (header && header.kind === "parent" && (!inputTrace || inputTrace.traceId === header.traceId)) {
            // Scheduled by an observed workflow of the same trace: nest
            // under its span. When the input carries a different trace (a
            // turn signalled into a long-running supervisor), the input's
            // traceparent is the truer origin and wins below.
            traceId = header.traceId;
            parentSpanId = header.spanId;
          } else {
            // API-started: parent to the propagated traceparent span id.
            // Otherwise: a fresh deterministic trace for worker-internal runs.
            traceId = inputTrace ? inputTrace.traceId : workflowTraceId(info.workflowId, info.runId);
            parentSpanId = inputTrace ? inputTrace.parentId : null;
          }
          if (header && header.kind === "link") {
            // A continue-as-new run links to the run it continues.
            links.push({ traceId: header.traceId, spanId: header.spanId });
          }
          if (correlation.sourceTraceparent) {
            // A background continuation links to the trace of the run it continues.
            links.push({ traceId: correlation.sourceTraceparent.traceId, spanId: correlation.sourceTraceparent.parentId });
          }
          const span = { traceId, spanId: workflowSpanId(info.workflowId, info.runId) };
          current = span;
          startedWithoutInputTraceparent = !inputTrace;
          spanParentId = parentSpanId;
          spanAttributes = { ...correlation.attributes };
          const startedAtMs = Date.now();
          const emit = (outcome: WorkflowSpanEvent["outcome"]) => {
            workerSpans.workflowSpan({
              traceId: current!.traceId,
              spanId: current!.spanId,
              parentSpanId: spanParentId,
              name: "workflow " + info.workflowType,
              workflowType: info.workflowType,
              workflowId: info.workflowId,
              runId: info.runId,
              attempt: info.attempt,
              startedAtMs,
              endedAtMs: Date.now(),
              outcome,
              attributes: {
                ...spanAttributes,
                "space.workflow_type": info.workflowType,
                "space.attempt": info.attempt,
                "space.outcome": outcome
              },
              links
            });
          };
          try {
            const result = await next(input);
            emit("COMPLETED");
            return result;
          } catch (error) {
            if (error instanceof ContinueAsNew) emit("CONTINUED");
            else emit(isCancellation(error) ? "CANCELLED" : "FAILED");
            throw error;
          }
        },
        handleSignal: async (input: SignalInput, next) => {
          // A long-running supervisor (roomAgentSupervisorWorkflow) starts
          // without a traceparent; enqueueRoomAgentTurn-style signals carry
          // the request's correlation. Adopt it for outbound work after the
          // signal. Replay re-delivers signals in order, so headers stay
          // deterministic.
          adoptSignalCorrelation(input.args);
          await next(input);
        }
      }
    ],
    outbound: [outbound]
  };
}
