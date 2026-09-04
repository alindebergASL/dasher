import { describe, expect, it } from "vitest";

import { SlidingWindowThrottle, clientKey } from "./throttle";

describe("SlidingWindowThrottle", () => {
  it("allows up to the limit within a window and refuses the next", () => {
    const throttle = new SlidingWindowThrottle(3, 1_000);

    expect(throttle.allow("a", 0)).toBe(true);
    expect(throttle.allow("a", 100)).toBe(true);
    expect(throttle.allow("a", 200)).toBe(true);
    expect(throttle.allow("a", 300)).toBe(false);
  });

  it("slides: a call outside the window no longer counts", () => {
    const throttle = new SlidingWindowThrottle(2, 1_000);

    expect(throttle.allow("a", 0)).toBe(true);
    expect(throttle.allow("a", 500)).toBe(true);
    expect(throttle.allow("a", 900)).toBe(false);
    // The call at 0 has aged out; the one at 500 has not.
    expect(throttle.allow("a", 1_001)).toBe(true);
    expect(throttle.allow("a", 1_100)).toBe(false);
    // Both 500 and 1001 are still inside the window at 1400.
    expect(throttle.allow("a", 1_400)).toBe(false);
    expect(throttle.allow("a", 1_501)).toBe(true);
  });

  it("keeps keys independent", () => {
    const throttle = new SlidingWindowThrottle(1, 1_000);

    expect(throttle.allow("a", 0)).toBe(true);
    expect(throttle.allow("b", 0)).toBe(true);
    expect(throttle.allow("a", 1)).toBe(false);
    expect(throttle.allow("b", 1)).toBe(false);
  });

  it("does not count a refused call against the caller", () => {
    // Otherwise a client at the limit could never get back under it while it
    // keeps retrying, and the window would stop sliding for it.
    const throttle = new SlidingWindowThrottle(1, 1_000);

    expect(throttle.allow("a", 0)).toBe(true);
    expect(throttle.allow("a", 900)).toBe(false);
    expect(throttle.allow("a", 1_001)).toBe(true);
  });

  it("forgets a key whose calls have all aged out", () => {
    const throttle = new SlidingWindowThrottle(1, 1_000);

    throttle.allow("a", 0);
    expect(throttle.size).toBe(1);
    // A refused probe long after the window prunes the stale entry itself.
    expect(throttle.allow("a", 5_000)).toBe(true);
    expect(throttle.size).toBe(1);
  });

  it("bounds the number of keys it remembers, evicting the least recent", () => {
    const throttle = new SlidingWindowThrottle(5, 60_000, 3);

    throttle.allow("a", 0);
    throttle.allow("b", 1);
    throttle.allow("c", 2);
    expect(throttle.size).toBe(3);

    throttle.allow("d", 3);
    expect(throttle.size).toBe(3);
    // "a" was evicted, so it starts a fresh count and is allowed again.
    expect(throttle.allow("a", 4)).toBe(true);
    expect(throttle.size).toBe(3);
  });

  it("defaults to a ten-thousand-key bound", () => {
    const throttle = new SlidingWindowThrottle(1, 60_000);
    for (let index = 0; index < 10_500; index += 1) {
      throttle.allow(`key-${String(index)}`, index);
    }
    expect(throttle.size).toBe(10_000);
  });

  it("uses the wall clock when no time is given", () => {
    const throttle = new SlidingWindowThrottle(1, 60_000);
    expect(throttle.allow("a")).toBe(true);
    expect(throttle.allow("a")).toBe(false);
  });

  it("refuses a nonsensical configuration", () => {
    expect(() => new SlidingWindowThrottle(0, 1_000)).toThrow(RangeError);
    expect(() => new SlidingWindowThrottle(1.5, 1_000)).toThrow(RangeError);
    expect(() => new SlidingWindowThrottle(1, 0)).toThrow(RangeError);
    expect(() => new SlidingWindowThrottle(1, 1_000, 0)).toThrow(RangeError);
  });
});

describe("clientKey", () => {
  it("takes the last x-forwarded-for hop, the one the proxy appended", () => {
    expect(
      clientKey(
        new Headers({ "x-forwarded-for": " 203.0.113.9 , 10.0.0.1, 10.0.0.2" }),
      ),
    ).toBe("10.0.0.2");
  });

  it("ignores hops the caller seeded ahead of the proxy's", () => {
    const throttle = new SlidingWindowThrottle(2, 1_000);
    const spoofed = (n: number) =>
      clientKey(
        new Headers({ "x-forwarded-for": `9.9.9.${String(n)}, 203.0.113.7` }),
      );
    expect(throttle.allow(spoofed(1), 0)).toBe(true);
    expect(throttle.allow(spoofed(2), 0)).toBe(true);
    expect(throttle.allow(spoofed(3), 0)).toBe(false);
    expect(throttle.size).toBe(1);
  });

  it("caps the key so a long header cannot pin memory", () => {
    const key = clientKey(
      new Headers({ "x-forwarded-for": "a".repeat(5_000) }),
    );
    expect(key.length).toBeLessThanOrEqual(64);
  });

  it("falls back to x-real-ip", () => {
    expect(clientKey(new Headers({ "x-real-ip": "198.51.100.4" }))).toBe(
      "198.51.100.4",
    );
    expect(
      clientKey(
        new Headers({ "x-forwarded-for": " , ", "x-real-ip": "198.51.100.4" }),
      ),
    ).toBe("198.51.100.4");
  });

  it("prefers x-forwarded-for over x-real-ip when both are present", () => {
    expect(
      clientKey(
        new Headers({
          "x-forwarded-for": "203.0.113.9",
          "x-real-ip": "198.51.100.4",
        }),
      ),
    ).toBe("203.0.113.9");
  });

  it("answers unknown when neither header is usable", () => {
    expect(clientKey(new Headers())).toBe("unknown");
    expect(clientKey(new Headers({ "x-real-ip": "   " }))).toBe("unknown");
  });
});
