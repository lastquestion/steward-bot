import PQueue from "p-queue";
import { CacheState } from "./cache";

export interface State {
  proposedTrain: Array<number>;
  enabled: boolean;
  decisionLog: Array<string>;
  queue: PQueue;
  cacheState: CacheState;
}
