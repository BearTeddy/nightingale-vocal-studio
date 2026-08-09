import { invoke } from "./runtime";

export interface YouTubeImportResult {
  downloaded: string[];
  library_path: string;
  warnings: string[];
}

export const importYouTube = async (url: string): Promise<YouTubeImportResult> =>
  invoke<YouTubeImportResult>("import_youtube", { url });
