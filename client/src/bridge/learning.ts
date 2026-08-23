import type { LearningAttemptPage } from "@/types/LearningAttemptPage";
import type { LearningState } from "@/types/LearningState";
import type { ListLearningAttemptsQuery } from "@/types/ListLearningAttemptsQuery";
import type { SaveLearnerProfileRequest } from "@/types/SaveLearnerProfileRequest";
import type { SaveLearningAttemptRequest } from "@/types/SaveLearningAttemptRequest";
import { invoke } from "./runtime";

export const loadLearningState = async (profile: string): Promise<LearningState> =>
  await invoke<LearningState>("load_learning_state", { profile });

export const saveLearningAttempt = async (request: SaveLearningAttemptRequest): Promise<void> =>
  await invoke<void>("save_learning_attempt", { request });

export const saveLearnerProfile = async (request: SaveLearnerProfileRequest): Promise<void> =>
  await invoke<void>("save_learner_profile", { request });

export const listLearningAttempts = async (
  query: ListLearningAttemptsQuery,
): Promise<LearningAttemptPage> =>
  await invoke<LearningAttemptPage>("list_learning_attempts", { query });

export const deleteLearningState = async (profile: string): Promise<void> =>
  await invoke<void>("delete_learning_state", { profile });
