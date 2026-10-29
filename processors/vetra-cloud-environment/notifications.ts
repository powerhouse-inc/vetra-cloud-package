/**
 * Environment notification webhook (state.notifications).
 *
 * The processor maps a few status operations to owner-facing events and POSTs
 * a small JSON payload to the environment's webhook. Delivery is best effort:
 * one attempt, 5s timeout, no retries, failures are logged and swallowed, and
 * the processor never awaits it — a slow or broken webhook can't hold up or
 * crash operation processing.
 *
 * The payload only carries the event, the environment's id/label, a timestamp
 * and (for failures) the reported code/message. Never env vars or secrets.
 */
import type { OperationWithContext } from "@powerhousedao/reactor-browser";
import { childLogger } from "document-model";
import type { EnvironmentNotifications } from "../../document-models/vetra-cloud-environment/index.js";
import {
  webhookUrlProblem,
  type NotificationEvent,
} from "../../document-models/vetra-cloud-environment/v1/src/reducers/notification-webhook.js";

const logger = childLogger(["vetra-cloud-environment-notifications"]);

export const WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * Operations older than this are not notified. A processor that replays the
 * operation log (new cursor, rebuilt read model) must not send owners a burst
 * of historical deployment messages.
 */
export const MAX_EVENT_AGE_MS = 15 * 60 * 1000;

const MAX_MESSAGE_LENGTH = 300;

export type NotificationDetail = { code: string; message: string };

export type NotificationPayload = {
  event: NotificationEvent;
  environmentId: string;
  environmentLabel: string | null;
  /** ISO-8601 time of the operation that raised the event. */
  at: string;
  detail?: NotificationDetail;
  /** One-line human message (Slack incoming webhooks read `text`). */
  text: string;
  /** Same message for Discord webhooks, which read `content`. */
  content: string;
};

export type PendingNotification = { url: string; payload: NotificationPayload };

const ACTION_EVENTS: Partial<Record<string, NotificationEvent>> = {
  REPORT_DEPLOYMENT_SUCCEEDED: "deployment.succeeded",
  REPORT_DEPLOYMENT_FAILED: "deployment.failed",
  TERMINATE_ENVIRONMENT: "environment.terminated",
};

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Maps an applied operation to an event, or null if it raises none. */
export function notificationEventFor(
  operation: OperationWithContext["operation"],
): { event: NotificationEvent; detail?: NotificationDetail } | null {
  // A refused operation changed nothing.
  if (operation.error) return null;
  const event = ACTION_EVENTS[operation.action.type];
  if (!event) return null;
  if (event !== "deployment.failed") return { event };
  const input = (operation.action.input ?? {}) as Partial<NotificationDetail>;
  return {
    event,
    detail: {
      code: typeof input.code === "string" ? input.code : "UNKNOWN",
      message:
        typeof input.message === "string"
          ? truncate(input.message, MAX_MESSAGE_LENGTH)
          : "",
    },
  };
}

/** Pure: builds the JSON body POSTed to the webhook. */
export function buildNotificationPayload(args: {
  event: NotificationEvent;
  environmentId: string;
  environmentLabel: string | null;
  at: string;
  detail?: NotificationDetail;
}): NotificationPayload {
  const name = `"${args.environmentLabel ?? args.environmentId}"`;
  let text: string;
  switch (args.event) {
    case "deployment.succeeded":
      text = `Vetra Cloud: deployment of ${name} succeeded`;
      break;
    case "deployment.failed": {
      const d = args.detail;
      text = `Vetra Cloud: deployment of ${name} failed${
        d ? ` (${d.code})${d.message ? `: ${d.message}` : ""}` : ""
      }`;
      break;
    }
    case "environment.terminated":
      text = `Vetra Cloud: environment ${name} is being terminated`;
      break;
  }
  // Keep the message one line for chat webhooks.
  text = text.replace(/\s*[\r\n]+\s*/g, " ");
  return {
    event: args.event,
    environmentId: args.environmentId,
    environmentLabel: args.environmentLabel,
    at: args.at,
    ...(args.detail ? { detail: args.detail } : {}),
    text,
    content: text,
  };
}

/**
 * The webhook URL to notify for `event`, or null when notifications are off,
 * the event isn't subscribed, or the stored URL no longer passes validation.
 */
export function webhookTarget(
  notifications: EnvironmentNotifications | null | undefined,
  event: NotificationEvent,
): string | null {
  const url = notifications?.webhookUrl;
  if (!url) return null;
  if (!notifications.events.includes(event)) return null;
  if (webhookUrlProblem(url)) return null;
  return url;
}

type EnvStateLike = {
  label?: string | null;
  notifications?: EnvironmentNotifications | null;
};

/**
 * Pure: picks the webhook deliveries raised by a batch of operations. Every
 * environment operation is considered (not just the last per document), using
 * the state that operation produced, so a later op in the same batch can't
 * hide a deployment result.
 */
export function collectNotifications(
  operations: readonly OperationWithContext[],
  now: number = Date.now(),
): PendingNotification[] {
  const out: PendingNotification[] = [];
  for (const { operation, context } of operations) {
    if (context.documentType !== "powerhouse/vetra-cloud-environment") continue;
    const raised = notificationEventFor(operation);
    if (!raised || !context.resultingState) continue;

    const at = operation.timestampUtcMs || new Date(now).toISOString();
    const ts = Date.parse(at);
    if (Number.isFinite(ts) && now - ts > MAX_EVENT_AGE_MS) continue;

    let state: EnvStateLike | undefined;
    try {
      state = (JSON.parse(context.resultingState) as { global?: EnvStateLike })
        .global;
    } catch {
      continue;
    }
    const url = webhookTarget(state?.notifications, raised.event);
    if (!url) continue;

    out.push({
      url,
      payload: buildNotificationPayload({
        event: raised.event,
        environmentId: context.documentId,
        environmentLabel: state?.label ?? null,
        at,
        detail: raised.detail,
      }),
    });
  }
  return out;
}

/**
 * One POST, 5s timeout, redirects refused (a redirect could point back into
 * the cluster). Resolves to whether the endpoint answered 2xx; never rejects.
 */
export async function deliverWebhook(
  { url, payload }: PendingNotification,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = WEBHOOK_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "vetra-cloud-notifications",
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn(
        `Webhook ${payload.event} for ${payload.environmentId} answered HTTP ${res.status}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(
      `Webhook ${payload.event} for ${payload.environmentId} failed: ${String(err)}`,
    );
    return false;
  }
}

/**
 * Fire-and-forget entry point for the processor: collects and delivers in the
 * background. Never throws, and the returned promise never rejects.
 */
export function sendNotifications(
  operations: readonly OperationWithContext[],
  deliver: (n: PendingNotification) => Promise<boolean> = deliverWebhook,
): Promise<void> {
  let pending: PendingNotification[];
  try {
    pending = collectNotifications(operations);
  } catch (err) {
    logger.warn(`Collecting notifications failed: ${String(err)}`);
    return Promise.resolve();
  }
  return Promise.all(pending.map((n) => deliver(n).catch(() => false))).then(
    () => undefined,
  );
}
