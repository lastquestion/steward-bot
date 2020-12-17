import PQueue from "p-queue";
import { Context } from "probot";

export interface Repo {
  proposedTrain: Array<number>;
  decisionLog: Array<string>;
  queue: PQueue;

  on: (action: string, context: Context) => void;

  enabled: boolean;
  mergingEnabled: boolean;
  enforceCodeFreeze?: boolean;
  codeFreezeBranchName?: string;
}

export type Repos = { [repo: string]: Repo };
