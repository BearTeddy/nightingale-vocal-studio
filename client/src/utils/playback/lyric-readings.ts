import type { Word } from "@/types/Transcript";

export function lyricPresentation(word: Word, japanese = "both", korean = "romanization") {
  const isJapanese = Boolean(word.annotations) || /[\u3040-\u30ff]/u.test(word.word);
  const isKorean = /[\uac00-\ud7af]/u.test(word.word);
  const mode = isJapanese ? japanese : isKorean ? korean : "romanization";
  const roman = word.romaji ?? word.romanization ?? word.reading;
  const ruby = isJapanese && (mode === "furigana" || mode === "both");
  const onlyRoman = mode === "romanization_only";
  const annotation = mode === "both" || mode === "romanization" ? roman : undefined;
  return {
    text: onlyRoman ? roman || word.word : word.word,
    annotation: annotation && annotation !== word.word ? annotation : undefined,
    parts: ruby ? word.annotations : undefined,
    separator: onlyRoman ? " " : (word.separator ?? (isJapanese ? "" : " ")),
  };
}
