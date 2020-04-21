/* eslint-disable @typescript-eslint/camelcase */

import { Application, Context, ApplicationFunction } from "probot"; // eslint-disable-line no-unused-vars
import { routes } from "./routes";
import { State } from "./state";
import PQueue from "p-queue";
import { CacheState } from "./cache";

// because we expect that the number of requests we need to make is high,
// use the old REST API because we can use ETags to avoid hitting our
// rate limits

type Config = {
  mutate: boolean;
  debug: boolean;
  appName: string;
  appRoute?: string;
};

function filterSuccess<T>(result: PromiseSettledResult<T>): result is PromiseFulfilledResult<T> {
  return result.status == "fulfilled";
}

function filterReject<T>(result: PromiseSettledResult<T>): result is PromiseRejectedResult {
  return result.status == "rejected";
}

export = (cacheState: CacheState, config: Config): { state: State; app: ApplicationFunction } => {
  const state: State = {
    proposedTrain: [],
    enabled: config.mutate,
    decisionLog: [],
    queue: new PQueue({ concurrency: 1 }),
    cacheState,
  };

  const log = (context: Context, str: string): void => {
    state.decisionLog.push(str);
    context.log(str);
  };

  const merge = async (context: Context, mergeTrain: Array<number>): Promise<void> => {
    if (mergeTrain.length == 0) return;

    log(context, `attempting to merge [${mergeTrain}]`);

    if (!config.mutate) {
      log(context, "ignoring merge; mutation off");
      return;
    }

    const results = await Promise.allSettled(
      mergeTrain.map(async (pr) => {
        try {
          const mergeResult = await context.github.pulls.merge({
            ...context.repo(),
            pull_number: pr,
            merge_method: "squash",
          });

          await context.github.issues.createComment({
            ...context.repo(),
            issue_number: pr,
            body: `This PR was merged by ${config.appName}. Thanks for your contribution.`,
          });
          return { pull_number: pr, mergeResult };
        } catch (err) {
          throw { pull_number: pr, err };
        }
      })
    );

    const successes = results.filter(filterSuccess).map((result) => result.value.pull_number);
    const failures = results.filter(filterReject).map((result) => result.reason.pull_number);

    log(context, `succeeded in merging [${successes}], failed to merge [${failures}]`);
    log(context, `failures reasons: ${JSON.stringify(failures)}`);
  };

  const checkMergeTrain = async (context: Context): Promise<void> => {
    try {
      if (state.proposedTrain.length == 0) {
        // we have no proposals, find all
        log(context, "there are no proposed trains, building a new one");

        const allIssues = await context.github.issues.listForRepo({
          ...context.repo(),
          state: "open",
          labels: "ready to merge",
          sort: "created",
          direction: "asc",
        });

        state.proposedTrain = allIssues.data.filter((issue) => !!issue.pull_request).map((pr) => pr.number);
      }

      const latestStatusAndPR = await Promise.all(
        state.proposedTrain.map(async (pr) => {
          const prResponse = await context.github.pulls.get({
            ...context.repo(),
            pull_number: pr,
          });

          const {
            head: { sha },
          } = prResponse.data;

          const combinedStatus = await context.github.repos.getCombinedStatusForRef({
            ...context.repo(),
            ref: sha,
          });

          return {
            pr: prResponse,
            combinedStatus,
          };
        })
      );

      if (config.debug) console.log(JSON.stringify(latestStatusAndPR, null, "  "));

      const newTrain = [] as Array<number>;
      const readyToMerge = [] as Array<number>;

      for (const elem of latestStatusAndPR) {
        const {
          combinedStatus: {
            data: { statuses },
          },
          pr: {
            data: { number, labels, mergeable_state },
          },
        } = elem;

        const mergeLabel = labels.find((label) => label.name == "ready to merge");
        const anyPending = statuses.some((status) => status.state == "pending");

        // if it's labeled,
        if (mergeLabel) {
          // and we're sure it can be merged...
          if (mergeable_state == "clean") {
            // prepare to merge it
            readyToMerge.push(number);
            newTrain.push(number);
          } else {
            // or, if we can't merge, but some tests are pending,
            // maybe it could be mergeable later?
            if (anyPending) {
              newTrain.push(number);
            }
          }
        }

        log(
          context,
          `${number} from the merge train: pending checks: ${anyPending ? "pending" : "none pending"} label: ${
            mergeLabel ? "labeled" : "not labeled"
          } ${mergeable_state}`
        );
      }

      log(context, `after recalculating, train: [${state.proposedTrain}] becomes new train [${newTrain}]`);

      if (newTrain.length == readyToMerge.length) {
        log(context, `in train [${newTrain}] all PRs ready to merge`);
        await merge(context, newTrain);
        state.proposedTrain = [];
      } else {
        log(context, `in train [${newTrain}] has [${readyToMerge}] ready to merge, some pending, waiting`);
        state.proposedTrain = newTrain;
      }
    } catch (e) {
      context.log.error(e);
    }
  };

  const checkSinglePr = async (pull_number: number, context: Context) => {
    const {
      data: { number, labels, mergeable_state },
    } = await context.github.pulls.get({
      ...context.repo(),
      pull_number,
    });

    const mergeLabel = labels.find((label) => label.name == "ready to merge");

    // if it's labeled and we're sure it can be merged...
    if (mergeLabel && mergeable_state == "clean") {
      // Add it to the proposed list
      state.proposedTrain.push(number);

      log(context, `${number} added to the proposed train: clean and ready to merge`);
    }
  };

  const logAndEnqueue = (
    job: ((context: Context) => Promise<void>) | (() => Promise<void>),
    type: string,
    context: Context
  ): void => {
    if (!state.enabled) {
      context.log("not enabled, bailing");
      return;
    }

    context.log(`enqueue at length ${state.queue.size}`);

    const requestDate = new Date();

    state.queue.add(async () => {
      state.decisionLog = [];
      log(context, `request at: ${requestDate} processed at ${new Date()} event type ${type}`);
      await job(context);
      log(context, "request complete");
    });
  };

  const appRoute = config.appRoute || `/${config.appName}`;

  const mergeApp = (app: Application): void => {
    routes(state, appRoute, app.route(appRoute));

    app.on("status", async (context: Context) => {
      // it's tricky to figure out the branch from the sha.
      // just find the mergeability of all prs in the train every time
      // and rely on the fact that we cache the REST calls so it's not deathly
      // inefficient.
      logAndEnqueue(checkMergeTrain, "status", context);
    });

    app.on("pull_request.labeled", async (context: Context) => {
      const {
        label,
        pull_request: { number },
      } = context.payload;

      if (label.name == "ready to merge") {
        context.log(`PR labeled for merge ${number}`);
        logAndEnqueue(
          async () => {
            if (state.proposedTrain.length == 0) {
              log(context, `PR ${number} labeled; proposed trains empty, starting`);
              await checkMergeTrain(context);
            } else {
              await checkSinglePr(number, context);
            }
          },
          "labeled",
          context
        );
      }
    });

    app.on("pull_request.unlabeled", async (context: Context) => {
      const {
        label,
        pull_request: { number },
      } = context.payload;

      if (label.name == "ready to merge") {
        logAndEnqueue(
          async () => {
            if (state.proposedTrain.indexOf(number) != -1) {
              log(
                context,
                `PR ${number} was part of proposed train ${state.proposedTrain}, but was unlabeled. Removing`
              );
              state.proposedTrain = state.proposedTrain.filter((id) => id != number);

              await checkMergeTrain(context);
            }
          },
          "unlabeled",
          context
        );
      }
    });
  };

  return {
    app: mergeApp,
    state,
  };
};
