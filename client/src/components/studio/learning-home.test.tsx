import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LearningHome } from "./learning-home";

describe("LearningHome", () => {
  it("presents a varied, beginner-friendly foundation plan", () => {
    const markup = renderToStaticMarkup(
      <LearningHome
        progress={[]}
        comfortableRange={null}
        onOpenSetup={() => undefined}
        onStartLesson={() => undefined}
        onOpenTechnique={() => undefined}
        onOpenSongs={() => undefined}
        onOpenProgress={() => undefined}
      />,
    );

    expect(markup).toContain("FOUNDATION");
    expect(markup).not.toContain("STAGE 0");
    expect(markup).toContain("Your 10-minute plan");
    expect(markup).toContain("Repeat once: Set up your voice space");
    expect(markup).toContain("Next step: Follow the direction");
    expect(markup).toContain("Start foundation setup");
  });
});
