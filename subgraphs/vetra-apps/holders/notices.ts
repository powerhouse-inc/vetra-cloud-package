export type HolderNoticeKind =
  | "EXPIRING" // licence ends within 7 days
  | "ENDED_STOP_PENDING" // ended; stops at endedAt + stopAfterDays
  | "STOPPED" // stopped; data kept (destroy off)
  | "STOPPED_DELETE_PENDING" // stopped; deleted at endedAt + destroyAfterDays (destroy on)
  | "DELETE_IMMINENT" // the last 7 days before deletion
  | "APP_DISCONTINUED"; // the App is being deleted on dueAt (PR B)

export interface HolderNotice {
  kind: HolderNoticeKind;
  at: string | null;
  message: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const EXPIRY_WARNING_DAYS = 7;
export const FINAL_WARNING_DAYS = 7;
export const DESTROY_AFTER_DAYS = 90;

const day = (iso: string) => iso.slice(0, 10);
const addDays = (iso: string, days: number) =>
  new Date(Date.parse(iso) + days * DAY_MS).toISOString();

/**
 * What an own instance's holder is told about their licence ending (spec
 * 14.5), in licensing's `subscriptionWarnings` wording. Pure.
 * `endAt`: the live head's end; `endedAt`: when the chain was seen without a
 * live licence; `stopped`: Vetra has put the instance to sleep.
 */
export function holderNotices(input: {
  now: string;
  endAt: string | null;
  endedAt: string | null;
  stopped: boolean;
  stopAfterDays: number;
  destroy: { enabled: boolean; afterDays: number };
  appDeletionDueAt?: string | null;
}): HolderNotice[] {
  const out: HolderNotice[] = [];
  const nowMs = Date.parse(input.now);
  if (input.endedAt) {
    const stopAt = addDays(input.endedAt, input.stopAfterDays);
    const stopPassed = nowMs >= Date.parse(stopAt);
    if (!input.stopped && !stopPassed) {
      out.push({
        kind: "ENDED_STOP_PENDING",
        at: stopAt,
        message: `Your instance stops on ${day(stopAt)}. Renew to keep it running.`,
      });
    } else if (input.destroy.enabled) {
      const deleteAt = addDays(input.endedAt, input.destroy.afterDays);
      const imminent =
        nowMs >= Date.parse(addDays(deleteAt, -FINAL_WARNING_DAYS));
      out.push(
        imminent
          ? {
              kind: "DELETE_IMMINENT",
              at: deleteAt,
              message: `Your stopped instance will be deleted on ${day(deleteAt)}.`,
            }
          : {
              kind: "STOPPED_DELETE_PENDING",
              at: deleteAt,
              message: `Your instance is stopped; its data is deleted on ${day(deleteAt)}. Renew your licence to bring it back.`,
            },
      );
    } else {
      out.push({
        kind: "STOPPED",
        at: null,
        message:
          "Your instance is stopped; its data is kept. Renew your licence to bring it back.",
      });
    }
  }
  const endMs = input.endAt === null ? Number.NaN : Date.parse(input.endAt);
  if (
    !input.endedAt &&
    !Number.isNaN(endMs) &&
    nowMs < endMs &&
    nowMs >= endMs - EXPIRY_WARNING_DAYS * DAY_MS
  ) {
    const days = Math.ceil((endMs - nowMs) / DAY_MS);
    out.push({
      kind: "EXPIRING",
      at: new Date(endMs).toISOString(),
      message: `Your licence expires in ${days} ${days === 1 ? "day" : "days"}.`,
    });
  }
  if (input.appDeletionDueAt)
    out.push({
      kind: "APP_DISCONTINUED",
      at: input.appDeletionDueAt,
      message: `This App is being discontinued on ${day(input.appDeletionDueAt)}.`,
    });
  return out;
}
