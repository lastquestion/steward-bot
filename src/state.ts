import PQueue from "p-queue";
import { CacheState } from "./cache";
export interface State {
  proposedTrain: Array<number>;
  enabled: boolean;
  mergingEnabled: boolean;
  decisionLog: Array<string>;
  queue: PQueue;
  cacheState: CacheState;
  [key: string]: boolean | CacheState | PQueue | Array<string> | Array<number>;
}
