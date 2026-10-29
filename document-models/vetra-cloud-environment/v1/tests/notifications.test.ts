import { describe, expect, it } from "vitest";
import {
  initialize,
  markChangesPushed,
  markDeploymentStarted,
  reducer,
  reportDeploymentSucceeded,
  setNotificationWebhook,
  setOwner,
  utils,
} from "document-models/vetra-cloud-environment/v1";
import {
  NOTIFICATION_EVENTS,
  normalizeNotificationEvents,
  webhookUrlProblem,
} from "../src/reducers/notification-webhook.js";

const ALICE = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BOB = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const userSigner = (address: string) => ({
  context: {
    signer: {
      user: { address, networkId: "eip155:1", chainId: 1 },
      app: { name: "test", key: "test" },
      signatures: [],
    },
  },
});

const HOOK = "https://hooks.slack.com/services/T000/B000/XXXX";

/** A deployed (READY) environment owned by ALICE. */
function readyOwned() {
  let doc = reducer(utils.createDocument(), {
    ...setOwner({ address: ALICE }),
    ...userSigner(ALICE),
  });
  doc = reducer(
    doc,
    initialize({
      genericSubdomain: "notify",
      genericBaseDomain: "test.example.com",
    }),
  );
  doc = reducer(doc, markChangesPushed({}));
  doc = reducer(doc, markDeploymentStarted({}));
  doc = reducer(doc, reportDeploymentSucceeded({}));
  return doc;
}

describe("SET_NOTIFICATION_WEBHOOK", () => {
  it("starts null (no notifications)", () => {
    expect(utils.createDocument().state.global.notifications).toBeNull();
  });

  it("stores url + events and leaves a deployed env READY", () => {
    const before = readyOwned();
    expect(before.state.global.status).toBe("READY");
    const doc = reducer(before, {
      ...setNotificationWebhook({
        url: HOOK,
        events: ["deployment.failed", " deployment.failed ", ""],
      }),
      ...userSigner(ALICE),
    });
    expect(doc.operations.global.at(-1)?.error).toBeUndefined();
    expect(doc.state.global.notifications).toStrictEqual({
      webhookUrl: HOOK,
      events: ["deployment.failed"],
    });
    expect(doc.state.global.status).toBe("READY");
  });

  it("null events subscribes to every event", () => {
    const doc = reducer(readyOwned(), {
      ...setNotificationWebhook({ url: HOOK }),
      ...userSigner(ALICE),
    });
    expect(doc.state.global.notifications?.events).toStrictEqual([
      ...NOTIFICATION_EVENTS,
    ]);
  });

  it("a null or blank url turns the webhook off", () => {
    let doc = reducer(readyOwned(), {
      ...setNotificationWebhook({ url: HOOK, events: [] }),
      ...userSigner(ALICE),
    });
    doc = reducer(doc, {
      ...setNotificationWebhook({ url: null, events: [] }),
      ...userSigner(ALICE),
    });
    expect(doc.state.global.notifications).toStrictEqual({
      webhookUrl: null,
      events: [],
    });
    doc = reducer(doc, {
      ...setNotificationWebhook({ url: "   ", events: [] }),
      ...userSigner(ALICE),
    });
    expect(doc.operations.global.at(-1)?.error).toBeUndefined();
    expect(doc.state.global.notifications?.webhookUrl).toBeNull();
    expect(doc.state.global.status).toBe("READY");
  });

  it.each([
    "http://hooks.example.com/x",
    "not a url",
    "https://user:pw@hooks.example.com/x",
    "https://localhost/x",
    "https://metadata.google.internal/x",
    "https://kubernetes.default.svc/x",
    "https://10.0.0.1/x",
    "https://169.254.169.254/latest",
    "https://[::1]/x",
  ])("rejects %s with InvalidWebhookUrlError", (url) => {
    const doc = reducer(readyOwned(), {
      ...setNotificationWebhook({ url }),
      ...userSigner(ALICE),
    });
    expect(doc.operations.global.at(-1)?.error).toMatch(/Webhook URL/);
    expect(doc.state.global.notifications).toBeNull();
  });

  it("rejects a non-owner", () => {
    const doc = reducer(readyOwned(), {
      ...setNotificationWebhook({ url: HOOK }),
      ...userSigner(BOB),
    });
    expect(doc.operations.global.at(-1)?.error).toMatch(/is not the owner/i);
    expect(doc.state.global.notifications).toBeNull();
  });
});

describe("webhookUrlProblem", () => {
  it.each([
    HOOK,
    "https://discord.com/api/webhooks/1/abc",
    "https://8.8.8.8/hook",
    "https://hooks.example.com:8443/x?y=1",
  ])("accepts %s", (url) => {
    expect(webhookUrlProblem(url)).toBeNull();
  });

  it.each([
    ["https://" + "a".repeat(2050) + ".com", /at most/],
    ["https://intranet/x", /public hostname/],
    ["https://printer.local/x", /public hostname/],
    ["https://192.168.1.1/x", /private IP/],
    ["https://172.20.0.1/x", /private IP/],
    ["https://100.64.0.1/x", /private IP/],
    ["https://127.0.0.1/x", /private IP/],
  ])("rejects %s", (url, reason) => {
    expect(webhookUrlProblem(url)).toMatch(reason);
  });
});

describe("normalizeNotificationEvents", () => {
  it("keeps order, trims and dedupes", () => {
    expect(
      normalizeNotificationEvents(["b", "a", " b", "custom.event"]),
    ).toStrictEqual(["b", "a", "custom.event"]);
  });
});
