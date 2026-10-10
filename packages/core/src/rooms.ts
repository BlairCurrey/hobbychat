import type { RoomPolicy } from "./config.ts";

const SLUG = /^[a-z0-9_-]{1,64}$/;

/** App IDs and room names share one charset: lowercase letters, digits, `-`, `_`, max 64 chars. */
export function isValidSlug(value: string): boolean {
  return SLUG.test(value);
}

/** Whether a room name is allowed by an app's room policy. */
export function isRoomAllowed(policy: RoomPolicy, room: string): boolean {
  if (!isValidSlug(room)) return false;
  if (policy === "open") return true;
  if (policy instanceof RegExp) {
    policy.lastIndex = 0; // global/sticky regexes are stateful
    return policy.test(room);
  }
  return policy.includes(room);
}
