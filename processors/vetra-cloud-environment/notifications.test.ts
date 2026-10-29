import type { OperationWithContext } from "@powerhousedao/reactor-browser";
import { describe, expect, it, vi } from "vitest";
import {
  buildNotificationPayload,
  collectNotifications,
  deliverWebhook,
  MAX_EVENT_AGE_MS,
  sendNotifications,
  type PendingNotification,
} from "./notifications.js";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const HOOK = "https://hooks.example.com/abc";
const ALL = [
  "deployment.succeeded",
  "deployment.failed",
  "environment.terminated",
];

function op(
  type: string,
  {
    input = {},
    notifications = { webhookUrl: HOOK, events: ALL } as {
      webhookUrl: string | null;
      events: string[];
    } | null,
    error,
    at = new Date(NOW - 1000).toISOString(),
    documentType = "powerhouse/vetra-cloud-environment",
    label = "my-env" as string | null,
  }: {
    input?: unknown;
    notifications?: { webhookUrl: string | null; events: string[] } | null;
    error?: string;
    at?: string;
    documentType?: string;
    label?: string | null;
  } = {},
): OperationWithContext {
  return {
    operation: {
      action: { type, input },
      error,
      timestampUtcMs: at,
    },
    context: {
      documentId: "env-1",
      documentType,
      resultingState: JSON.stringify({
        global: {
          label,
          notifications,
          services: [{ env: [{ name: "SECRET", value: "s3cr3t" }] }],
        },
      }),
    },
  } as unknown as OperationWithContext;
}

describe("buildNotificationPayload", () => {
  it("deployment.succeeded", () => {
    expect(
      buildNotificationPayload({
        event: "deployment.succeeded",
        environmentId: "env-1",
        environmentLabel: "my-env",
        at: "2026-10-29T12:00:00.000Z",
      }),
    ).toStrictEqual({
      event: "deployment.succeeded",
      environmentId: "env-1",
      environmentLabel: "my-env",
      at: "2026-10-29T12:00:00.000Z",
      text: 'Vetra Cloud: deployment of "my-env" succeeded',
      content: 'Vetra Cloud: deployment of "my-env" succeeded',
    });
  });

  it("deployment.failed carries code/message on one line", () => {
    const p = buildNotificationPayload({
      event: "deployment.failed",
      environmentId: "env-1",
      environmentLabel: null,
      at: "t",
      detail: { code: "CRASHLOOP", message: "pod\nrestarting" },
    });
    expect(p.detail).toStrictEqual({
      code: "CRASHLOOP",
      message: "pod\nrestarting",
    });
    expect(p.text).toBe(
      'Vetra Cloud: deployment of "env-1" failed (CRASHLOOP): pod restarting',
    );
    expect(p.content).toBe(p.text);
  });

  it("environment.terminated", () => {
    expect(
      buildNotificationPayload({
        event: "environment.terminated",
        environmentId: "env-1",
        environmentLabel: "x",
        at: "t",
      }).text,
    ).toBe('Vetra Cloud: environment "x" is being terminated');
  });
});

describe("collectNotifications", () => {
  it("maps the three actions to events", () => {
    const out = collectNotifications(
      [
        op("REPORT_DEPLOYMENT_SUCCEEDED"),
        op("REPORT_DEPLOYMENT_FAILED", {
          input: { code: "E1", message: "boom" },
        }),
        op("TERMINATE_ENVIRONMENT"),
        op("SET_LABEL"),
      ],
      NOW,
    );
    expect(out.map((n) => n.payload.event)).toStrictEqual(ALL);
    expect(out.every((n) => n.url === HOOK)).toBe(true);
    expect(out[1]?.payload.detail).toStrictEqual({
      code: "E1",
      message: "boom",
    });
  });

  it("never includes env vars or secrets", () => {
    const [n] = collectNotifications([op("REPORT_DEPLOYMENT_SUCCEEDED")], NOW);
    expect(JSON.stringify(n?.payload)).not.toContain("s3cr3t");
  });

  it("skips when no webhook is set", () => {
    expect(
      collectNotifications(
        [
          op("REPORT_DEPLOYMENT_SUCCEEDED", { notifications: null }),
          op("REPORT_DEPLOYMENT_SUCCEEDED", {
            notifications: { webhookUrl: null, events: ALL },
          }),
        ],
        NOW,
      ),
    ).toStrictEqual([]);
  });

  it("skips events that aren't subscribed", () => {
    expect(
      collectNotifications(
        [
          op("REPORT_DEPLOYMENT_SUCCEEDED", {
            notifications: { webhookUrl: HOOK, events: ["deployment.failed"] },
          }),
        ],
        NOW,
      ),
    ).toStrictEqual([]);
  });

  it("skips refused, stale, foreign and invalid-URL operations", () => {
    expect(
      collectNotifications(
        [
          op("REPORT_DEPLOYMENT_SUCCEEDED", {
            error: "InvalidStatusTransition",
          }),
          op("REPORT_DEPLOYMENT_SUCCEEDED", {
            at: new Date(NOW - MAX_EVENT_AGE_MS - 1).toISOString(),
          }),
          op("REPORT_DEPLOYMENT_SUCCEEDED", {
            documentType: "powerhouse/document-drive",
          }),
          op("REPORT_DEPLOYMENT_SUCCEEDED", {
            notifications: { webhookUrl: "http://10.0.0.1/x", events: ALL },
          }),
        ],
        NOW,
      ),
    ).toStrictEqual([]);
  });
});

describe("deliverWebhook", () => {
  const n: PendingNotification = {
    url: HOOK,
    payload: buildNotificationPayload({
      event: "deployment.succeeded",
      environmentId: "env-1",
      environmentLabel: "my-env",
      at: "t",
    }),
  };

  it("POSTs JSON once with a timeout and no redirects", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(
      deliverWebhook(n, fetchMock as unknown as typeof fetch),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(HOOK);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toStrictEqual(n.payload);
  });

  it("swallows network errors and non-2xx answers", async () => {
    const throwing = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      deliverWebhook(n, throwing as unknown as typeof fetch),
    ).resolves.toBe(false);
    const failing = vi.fn(async () => new Response("no", { status: 500 }));
    await expect(
      deliverWebhook(n, failing as unknown as typeof fetch),
    ).resolves.toBe(false);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("gives up after the timeout", async () => {
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    await expect(
      deliverWebhook(n, hanging as unknown as typeof fetch, 20),
    ).resolves.toBe(false);
  });
});

describe("sendNotifications", () => {
  it("does nothing when notifications are disabled", async () => {
    const deliver = vi.fn(async () => true);
    await sendNotifications(
      [op("REPORT_DEPLOYMENT_SUCCEEDED", { notifications: null })],
      deliver,
    );
    expect(deliver).not.toHaveBeenCalled();
  });

  it("never rejects, even if delivery throws or state is garbage", async () => {
    const deliver = vi.fn(async () => {
      throw new Error("boom");
    });
    const garbage = {
      ...op("REPORT_DEPLOYMENT_SUCCEEDED"),
      context: {
        documentId: "env-2",
        documentType: "powerhouse/vetra-cloud-environment",
        resultingState: "{not json",
      },
    } as unknown as OperationWithContext;
    await expect(
      sendNotifications(
        [
          op("REPORT_DEPLOYMENT_SUCCEEDED", { at: new Date().toISOString() }),
          garbage,
        ],
        deliver,
      ),
    ).resolves.toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
