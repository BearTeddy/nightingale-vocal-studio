import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Progress } from "./progress";

describe("Progress", () => {
  it("exposes its current value to assistive technology", () => {
    const markup = renderToStaticMarkup(<Progress value={42} aria-label="Lesson progress" />);

    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="42"');
    expect(markup).toContain('aria-label="Lesson progress"');
  });
});
