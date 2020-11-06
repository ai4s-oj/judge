import winston from "winston";

import { Task } from "@/task";
import { ensureFiles } from "@/file";
import { ConfigurationError, CanceledError } from "@/error";
import { OmittableString } from "@/omittableString";

import { SubmissionFile, SubmissionFileInfo } from "./submissionFile";

import * as Traditional from "./traditional";
import * as Interaction from "./interaction";
import * as SubmitAnswer from "./submit-answer";

/* eslint-disable @typescript-eslint/no-shadow */
enum ProblemType {
  Traditional = "Traditional",
  Interaction = "Interaction",
  SubmitAnswer = "SubmitAnswer"
}
/* eslint-enable @typescript-eslint/no-shadow */

export interface ProblemSample {
  inputData: string;
  outputData: string;
}

export interface SubmissionExtraInfo<JudgeInfo, SubmissionContent> {
  problemType: ProblemType;
  judgeInfo: JudgeInfo;
  samples?: ProblemSample[];
  testData: Record<string, string>; // filename -> uuid
  submissionContent: SubmissionContent;
  file?: SubmissionFileInfo;
}

export enum SubmissionProgressType {
  Preparing = "Preparing",
  Compiling = "Compiling",
  Running = "Running",
  Finished = "Finished"
}

export enum SubmissionStatus {
  Pending = "Pending",

  // eslint-disable-next-line @typescript-eslint/no-shadow
  ConfigurationError = "ConfigurationError",
  SystemError = "SystemError",
  Canceled = "Canceled",

  CompilationError = "CompilationError",

  FileError = "FileError",
  RuntimeError = "RuntimeError",
  TimeLimitExceeded = "TimeLimitExceeded",
  MemoryLimitExceeded = "MemoryLimitExceeded",
  OutputLimitExceeded = "OutputLimitExceeded",

  PartiallyCorrect = "PartiallyCorrect",
  WrongAnswer = "WrongAnswer",
  Accepted = "Accepted",

  JudgementFailed = "JudgementFailed"
}

interface TestcaseProgressReference {
  // If !waiting && !running && !testcaseHash, it's "Skipped"
  waiting?: boolean;
  running?: boolean;
  testcaseHash?: string;
}

export interface SubmissionProgress<TestcaseResult> {
  progressType: SubmissionProgressType;

  // Only valid when finished
  status?: SubmissionStatus;
  score?: number;
  totalOccupiedTime?: number;

  compile?: {
    success: boolean;
    message: OmittableString;
  };

  systemMessage?: OmittableString;

  // testcaseHash = hash(IF, OF, TL, ML) for traditional
  //                hash(ID, OD, TL, ML) for samples
  // ->
  // result
  testcaseResult?: Record<string, TestcaseResult>;
  samples?: TestcaseProgressReference[];
  subtasks?: {
    score: number;
    fullScore: number;
    testcases: TestcaseProgressReference[];
  }[];
}

export interface SubmissionTask<JudgeInfo, SubmissionContent, TestcaseResult, ExtraParameters>
  extends Task<SubmissionExtraInfo<JudgeInfo, SubmissionContent>, SubmissionProgress<TestcaseResult>> {
  events: {
    compiling(): void;
    compiled(compile: { success: boolean; message: OmittableString }): void;
    startedRunning(samplesCount: number, subtaskFullScores: number[]): void;
    sampleTestcaseWillEnqueue(
      sampleId: number,
      sample: ProblemSample,
      extraParameters: ExtraParameters
    ): Promise<TestcaseResult>;
    sampleTestcaseRunning(sampleId: number): void;
    sampleTestcaseFinished(sampleId: number, sample: ProblemSample, result: TestcaseResult): void;
    testcaseWillEnqueue(
      subtaskIndex: number,
      testcaseIndex: number,
      extraParameters: ExtraParameters
    ): Promise<TestcaseResult>;
    testcaseRunning(subtaskIndex: number, testcaseIndex: number): void;
    testcaseFinished(subtaskIndex: number, testcaseIndex: number, result: TestcaseResult): void;
    subtaskScoreUpdated(subtaskIndex: number, newScore: number): void;
    finished(status: SubmissionStatus, score: number): void;
  };

  // The file submitted by the user, will be automatically downloaded, only for some problem types.
  file?: SubmissionFile;
}

export interface SubmissionHandler<JudgeInfo, SubmissionContent, TestcaseResult, ExtraParameters> {
  validateJudgeInfo: (
    task: SubmissionTask<JudgeInfo, SubmissionContent, TestcaseResult, ExtraParameters>
  ) => Promise<void>;
  hashTestcase: (
    judgeInfo: JudgeInfo,
    subtaskIndex: number,
    testcaseIndex: number,
    testData: Record<string, string>,
    extraParameters: ExtraParameters
  ) => Promise<string>;
  hashSampleTestcase: (
    judgeInfo: JudgeInfo,
    sample: ProblemSample,
    extraParameters: ExtraParameters
  ) => Promise<string>;

  runTask: (task: SubmissionTask<JudgeInfo, SubmissionContent, TestcaseResult, ExtraParameters>) => Promise<void>;
}

const problemTypeHandlers: Record<ProblemType, SubmissionHandler<unknown, unknown, unknown, unknown>> = {
  [ProblemType.Traditional]: Traditional,
  [ProblemType.Interaction]: Interaction,
  [ProblemType.SubmitAnswer]: SubmitAnswer
};

// Common problem types' judge info has a "subtasks" array below.
interface JudgeInfoCommon {
  subtasks?: {
    testcases?: unknown[];
  }[];
}

function getSubtaskCount(judgeInfo: JudgeInfoCommon) {
  if (judgeInfo.subtasks) return judgeInfo.subtasks.length;
  return 1; // Non-common type
}

function getTestcaseCountOfSubtask(judgeInfo: JudgeInfoCommon, subtaskIndex: number) {
  if (judgeInfo.subtasks) return judgeInfo.subtasks[subtaskIndex].testcases.length;
  return 1; // Non-common type
}

export default async function onSubmission<JudgeInfo, SubmissionContent, TestcaseResult, ExtraParameters>(
  task: SubmissionTask<JudgeInfo, SubmissionContent, TestcaseResult, ExtraParameters>
): Promise<void> {
  // Calculate the total wall time time occupied by this submission
  const startTime = new Date();

  try {
    if (!(task.extraInfo.problemType in ProblemType)) {
      throw new ConfigurationError(`Unsupported problem type: ${task.extraInfo.problemType}`);
    }

    task.reportProgressRaw({
      progressType: SubmissionProgressType.Preparing
    });

    // Download testdata files
    const requiredFiles = Object.values(task.extraInfo.testData);
    await ensureFiles(requiredFiles);

    // Downlaod submission file
    if (task.extraInfo.file) {
      task.file = new SubmissionFile(task.extraInfo.file);
    }

    const problemTypeHandler = problemTypeHandlers[task.extraInfo.problemType];
    try {
      await problemTypeHandler.validateJudgeInfo(task);
    } catch (e) {
      if (typeof e === "string") throw new ConfigurationError(e);
      else throw e;
    }

    const { judgeInfo } = task.extraInfo;

    const progress: SubmissionProgress<TestcaseResult> = {
      progressType: null
    };

    const sampleTestcaseHashes: string[] = [];
    const testcaseHashes: string[][] = [];

    let finished = false;
    task.events = {
      compiling() {
        if (finished) return;
        task.reportProgressRaw({
          progressType: SubmissionProgressType.Compiling
        });
      },
      compiled(compile) {
        if (finished) return;
        progress.compile = compile;
      },
      startedRunning(samplesCount, subtaskFullScores) {
        if (finished) return;
        progress.progressType = SubmissionProgressType.Running;
        progress.testcaseResult = {};
        if (samplesCount) {
          progress.samples = [...new Array(samplesCount)].map(() => ({
            waiting: true
          }));
        }
        progress.subtasks = [...new Array(getSubtaskCount(judgeInfo)).keys()].map(subtaskIndex => ({
          score: null,
          fullScore: subtaskFullScores[subtaskIndex],
          testcases: [...new Array(getTestcaseCountOfSubtask(judgeInfo, subtaskIndex)).keys()].map(() => ({
            waiting: true
          }))
        }));
        task.reportProgressRaw(progress);
      },
      async sampleTestcaseWillEnqueue(sampleId, sample, extraParameters) {
        if (finished) return null;

        const testcaseHash = await problemTypeHandler.hashSampleTestcase(judgeInfo, sample, extraParameters);
        sampleTestcaseHashes[sampleId] = testcaseHash;

        if (progress.testcaseResult[testcaseHash]) return progress.testcaseResult[testcaseHash];

        return null;
      },
      sampleTestcaseRunning(sampleId) {
        if (finished) return;
        delete progress.samples[sampleId].waiting;
        progress.samples[sampleId].running = true;
        task.reportProgressRaw(progress);
      },
      sampleTestcaseFinished(sampleId, sample, result) {
        if (finished) return;
        delete progress.samples[sampleId].waiting;
        delete progress.samples[sampleId].running;
        if (result) {
          // If not "Skipped"
          const testcaseHash = sampleTestcaseHashes[sampleId];
          progress.samples[sampleId].testcaseHash = testcaseHash;
          progress.testcaseResult[testcaseHash] = result;
        }
        task.reportProgressRaw(progress);
      },
      async testcaseWillEnqueue(subtaskIndex, testcaseIndex, extraParameters) {
        if (finished) return null;
        if (!testcaseHashes[subtaskIndex]) testcaseHashes[subtaskIndex] = [];

        const testcaseHash = await problemTypeHandler.hashTestcase(
          judgeInfo,
          subtaskIndex,
          testcaseIndex,
          task.extraInfo.testData,
          extraParameters
        );
        testcaseHashes[subtaskIndex][testcaseIndex] = testcaseHash;

        if (progress.testcaseResult[testcaseHash]) return progress.testcaseResult[testcaseHash];

        return null;
      },
      testcaseRunning(subtaskIndex, testcaseIndex) {
        if (finished) return;
        delete progress.subtasks[subtaskIndex].testcases[testcaseIndex].waiting;
        progress.subtasks[subtaskIndex].testcases[testcaseIndex].running = true;
        task.reportProgressRaw(progress);
      },
      testcaseFinished(subtaskIndex, testcaseIndex, result) {
        if (finished) return;
        delete progress.subtasks[subtaskIndex].testcases[testcaseIndex].waiting;
        delete progress.subtasks[subtaskIndex].testcases[testcaseIndex].running;
        if (result) {
          // If not "Skipped"
          const testcaseHash = testcaseHashes[subtaskIndex][testcaseIndex];
          progress.subtasks[subtaskIndex].testcases[testcaseIndex].testcaseHash = testcaseHash;
          progress.testcaseResult[testcaseHash] = result;
        }
        task.reportProgressRaw(progress);
      },
      subtaskScoreUpdated(subtaskIndex, newScore) {
        if (finished) return;
        progress.subtasks[subtaskIndex].score = (newScore * progress.subtasks[subtaskIndex].fullScore) / 100;
        task.reportProgressRaw(progress);
      },
      finished(status, score) {
        if (finished) return;
        finished = true;
        progress.progressType = SubmissionProgressType.Finished;
        progress.status = status;
        progress.score = score;
        progress.totalOccupiedTime = +new Date() - +startTime;
        task.reportProgressRaw(progress);
      }
    };

    await problemTypeHandlers[task.extraInfo.problemType].runTask(task);
  } catch (e) {
    const isCanceled = e instanceof CanceledError;
    if (isCanceled) {
      // A canceled submission doesn't need futher reports
      throw e;
    }

    const isConfigurationError = e instanceof ConfigurationError;
    task.reportProgressRaw({
      progressType: SubmissionProgressType.Finished,
      status: isConfigurationError ? SubmissionStatus.ConfigurationError : SubmissionStatus.SystemError,
      systemMessage: isConfigurationError ? e.originalMessage : e.stack
    });
    if (!isConfigurationError) winston.error(`Error on submission task ${task.taskId}, ${e.stack}`);
  } finally {
    // Remove downloaded submission file
    if (task.file) task.file.dispose();
  }
}
