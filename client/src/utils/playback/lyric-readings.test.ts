import { describe, expect, it } from "vitest";
import { lyricPresentation } from "./lyric-readings";
import { normalizeLines, stripLrcToPlainLines } from "../edit-lyrics";
import type { Word } from "@/types/Transcript";

describe("lyric display choices", () => {
  const japanese: Word = {
    word: "今日",
    start: 0,
    end: 1,
    reading: "kyou",
    romaji: "kyou",
    separator: "",
    annotations: [{ text: "今日", furigana: "きょう", romaji: "kyou" }],
  };
  it("switches Japanese reading modes without replacing source text", () => {
    expect(lyricPresentation(japanese, "original")).toMatchObject({
      text: "今日",
      annotation: undefined,
      parts: undefined,
      separator: "",
    });
    expect(lyricPresentation(japanese, "furigana").parts?.[0].furigana).toBe("きょう");
    expect(lyricPresentation(japanese, "both").annotation).toBe("kyou");
    expect(lyricPresentation(japanese, "romanization_only").text).toBe("kyou");
  });
  it("supports Korean and leaves embedded English intact", () => {
    const korean = { word: "같이", reading: "gachi", start: 0, end: 1 };
    expect(lyricPresentation(korean, "both", "original").annotation).toBeUndefined();
    expect(lyricPresentation(korean, "both", "romanization_only").text).toBe("gachi");
    const english = { word: "Don't", start: 0, end: 1 };
    expect(lyricPresentation(english, "romanization_only", "romanization_only")).toMatchObject({
      text: "Don't",
      annotation: undefined,
    });
  });
  it("falls back to readable source text when a guide is missing", () => {
    expect(
      lyricPresentation(
        { word: "未知", annotations: [{ text: "未知" }], start: 0, end: 1 },
        "romanization_only",
      ).text,
    ).toBe("未知");
  });
});

describe("supplied lyrics", () => {
  it("removes section labels while preserving repetitions, punctuation and kanji", () => {
    expect(
      normalizeLines("[Verse 1]\r\n 今日も歌おう。\r\n[Chorus]\n今日も歌おう。\nDon't stop!"),
    ).toEqual(["今日も歌おう。", "今日も歌おう。", "Don't stop!"]);
  });
  it("normalizes decomposed Hangul and removes LRC tags before alignment", () => {
    expect(
      stripLrcToPlainLines(
        "[ar:Singer]\n[00:01.00]<00:01.00>같이 가요\n[00:04.00]한글".normalize("NFD"),
      ),
    ).toEqual(["같이 가요", "한글"]);
  });
});
