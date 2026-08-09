import { describe, expect, it, vi } from "vitest";
import { dispatchNewestFirst, type ConsumableSubscriber } from "./nav-dispatch";

describe("navigation dispatch", () => {
  it("offers actions to the most recently mounted subscriber first", () => {
    const calls: string[] = [];
    const subscribers: ConsumableSubscriber<string>[] = [
      () => {
        calls.push("page");
      },
      () => {
        calls.push("dialog");
      },
    ];

    expect(dispatchNewestFirst(subscribers, "confirm")).toBe(false);
    expect(calls).toEqual(["dialog", "page"]);
  });

  it("stops after an overlay consumes the action", () => {
    const page = vi.fn();
    const dialog = vi.fn(() => true);

    expect(dispatchNewestFirst([page, dialog], "back")).toBe(true);
    expect(dialog).toHaveBeenCalledWith("back");
    expect(page).not.toHaveBeenCalled();
  });
});
