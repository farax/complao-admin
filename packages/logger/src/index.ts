import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

/**
 * Phase 0 service logger. Every Complao service uses this to write one JSON event per step
 * (Appendix A) to standard output, where the platform ships it to CloudWatch Logs.
 *
 * R2: logging never fails or slows an action. Every write is wrapped so an error is dropped,
 * and nothing here awaits I/O on the request path.
 * R3: only IDs, codes, timings and counts. Do not put names, emails, prompts or document
 * content in `details`; the ingester strips keys that look like them, but don't rely on it.
 */

export type StepStatus = 'success' | 'failure' | 'skipped';

export interface ActionContext {
  actionId: string;
  actorId: string;
  /** The role the person is acting in: Auditor, TIC, CB, Admin. */
  actorRole: string | null;
  /** The sign-in session, from the auth layer (e.g. the session or token ID). */
  sessionId: string | null;
  caseId: string | null;
  component: string;
  /** Current parent step, for nesting. */
  parentStepId: string | null;
}

export interface LoggerOptions {
  component: string;
  /** Where events go. Defaults to stdout. Swap for a buffered background sender off-platform. */
  sink?: (line: string) => void;
}

const als = new AsyncLocalStorage<ActionContext>();

export function createActionLogger(opts: LoggerOptions) {
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + '\n'));
  const write = (event: Record<string, unknown>) => {
    try {
      sink(JSON.stringify(event));
    } catch {
      /* dropped on purpose: R2 */
    }
  };

  return {
    /**
     * Start a new action (a login, an audit, a registration stage). Writes action_start and
     * returns a handle; call `end` when the action finishes.
     */
    startAction(input: { actionType: string; actorId: string; caseId?: string | null; sessionId?: string | null; actorRole?: string | null }) {
      const ctx: ActionContext = {
        actionId: newTraceId(),
        actorId: input.actorId,
        actorRole: input.actorRole ?? null,
        sessionId: input.sessionId ?? null,
        caseId: input.caseId ?? null,
        component: opts.component,
        parentStepId: null,
      };
      const startedAt = Date.now();
      write({
        event_type: 'action_start',
        action_id: ctx.actionId,
        action_type: input.actionType,
        component: opts.component,
        started_at: new Date(startedAt).toISOString(),
        actor_id: ctx.actorId,
        actor_role: ctx.actorRole,
        session_id: ctx.sessionId,
        case_id: ctx.caseId,
      });
      return {
        ctx,
        /** Run `fn` with this action as the current context, so nested `step` calls attach to it. */
        run: <T>(fn: () => T) => als.run(ctx, fn),
        traceparent: () => toTraceparent(ctx.actionId),
        setCaseId: (caseId: string) => {
          ctx.caseId = caseId;
        },
        end: (status: StepStatus) =>
          write({
            event_type: 'action_end',
            action_id: ctx.actionId,
            component: opts.component,
            started_at: new Date(startedAt).toISOString(),
            latency_ms: Date.now() - startedAt,
            status,
            actor_id: ctx.actorId,
            actor_role: ctx.actorRole,
            session_id: ctx.sessionId,
            case_id: ctx.caseId,
          }),
      };
    },

    /**
     * Continue an action in a downstream service, from the traceparent header or a queue
     * message attribute. The case ID travels with the record, so pass it from the database.
     */
    continueAction<T>(
      input: { traceparent: string; actorId: string; caseId?: string | null; parentStepId?: string | null; sessionId?: string | null; actorRole?: string | null },
      fn: () => T,
    ): T {
      const actionId = parseTraceparent(input.traceparent);
      if (!actionId) return fn(); // no context: run the work, log nothing
      return als.run(
        {
          actionId,
          actorId: input.actorId,
          actorRole: input.actorRole ?? null,
          sessionId: input.sessionId ?? null,
          caseId: input.caseId ?? null,
          component: opts.component,
          parentStepId: input.parentStepId ?? null,
        },
        fn,
      );
    },

    /**
     * Time one step and write its event when it finishes. Nested `step` calls inside `fn`
     * become its children. Errors from `fn` are rethrown unchanged.
     */
    async step<T>(
      name: string,
      fn: (s: { details: Record<string, unknown>; setResponseCode: (c: string | number) => void; skip: () => void }) => Promise<T> | T,
      o: { details?: Record<string, unknown>; component?: string } = {},
    ): Promise<T> {
      const parent = als.getStore();
      if (!parent) return fn({ details: {}, setResponseCode: () => {}, skip: () => {} });
      const stepId = randomBytes(8).toString('hex');
      const details: Record<string, unknown> = { ...o.details };
      let responseCode: string | number = 200;
      let status: StepStatus = 'success';
      const started = Date.now();
      const emit = () =>
        write({
          event_type: 'step',
          action_id: parent.actionId,
          step_id: stepId,
          parent_step_id: parent.parentStepId,
          step_name: name,
          component: o.component ?? opts.component,
          started_at: new Date(started).toISOString(),
          latency_ms: Date.now() - started,
          status,
          response_code: String(responseCode),
          actor_id: parent.actorId,
          actor_role: parent.actorRole,
          session_id: parent.sessionId,
          case_id: parent.caseId,
          details: Object.keys(details).length ? details : undefined,
        });
      try {
        const result = await als.run({ ...parent, parentStepId: stepId }, () =>
          fn({ details, setResponseCode: (c) => (responseCode = c), skip: () => (status = 'skipped') }),
        );
        emit();
        return result;
      } catch (e) {
        status = 'failure';
        const err = e as { $metadata?: { httpStatusCode?: number }; statusCode?: number; name?: string };
        if (responseCode === 200) responseCode = err?.$metadata?.httpStatusCode ?? err?.statusCode ?? 500;
        if (err?.name) details.error_code = err.name;
        emit();
        throw e;
      }
    },

    current: () => als.getStore() ?? null,
  };
}

/** Copy model and token counts from a Bedrock Converse / InvokeModel response into step details. */
export function bedrockUsage(modelId: string, response: { usage?: { inputTokens?: number; outputTokens?: number; input_tokens?: number; output_tokens?: number } }) {
  const u = response.usage ?? {};
  return { model: modelId, input_tokens: u.inputTokens ?? u.input_tokens ?? 0, output_tokens: u.outputTokens ?? u.output_tokens ?? 0 };
}

export function newTraceId(): string {
  let id = '';
  while (!id || /^0+$/.test(id)) id = randomBytes(16).toString('hex');
  return id;
}

export function toTraceparent(actionId: string): string {
  return `00-${actionId}-${randomBytes(8).toString('hex')}-01`;
}

export function parseTraceparent(header: string | undefined | null): string | null {
  const m = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(String(header ?? '').trim());
  return m && !/^0+$/.test(m[1]) ? m[1].toLowerCase() : null;
}
