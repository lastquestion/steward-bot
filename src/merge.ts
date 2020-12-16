/* eslint-disable @typescript-eslint/camelcase */

import { Application, Context, ApplicationFunction } from "probot"; // eslint-disable-line no-unused-vars
import PQueue from "p-queue";

import { routes } from "./routes";
import { Repo, Repos } from "./repo";
import { CacheState } from "./cache";

type Config = {
  mutate: boolean;
  debug: boolean;
  enforceCodeFreeze?: boolean;
  codeFreezeBranchName?: string;
  appName: string;
  appRoute?: string;
};

function filterSuccess<T>(result: PromiseSettledResult<T>): result is PromiseFulfilledResult<T> {
  return result.status == "fulfilled";
}

function filterReject<T>(result: PromiseSettledResult<T>): result is PromiseRejectedResult {
  return result.status == "rejected";
}

function repo(config: Config): Repo {
  // because we expect that the number of requests we need to make is high,
  // use the old REST API because we can use ETags to avoid hitting our
  // rate limits

  const { enforceCodeFreeze = false, codeFreezeBranchName = "" } = config;

  const proposedTrain = [] as Array<number>;
  const decisionLog = [] as Array<string>;
  const queue = new PQueue({
    concurrency: 1,
  });

  let mergingEnabled = config.mutate;
  let enabled = config.mutate;

  const log = (context: Context, str: string): void => {
    decisionLog.push(str);
    context.log(str);
  };

  const merge = async (context: Context, mergeTrain: Array<number>): Promise<void> => {
    if (mergeTrain.length == 0) return;

    log(context, `attempting to merge [${mergeTrain}]`);

    if (!mergingEnabled) {
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
      let updatedTrain = proposedTrain;
      if (updatedTrain.length == 0) {
        // we have no proposals, find all
        log(context, "there are no proposed trains, building a new one");

        const allIssues = await context.github.issues.listForRepo({
          ...context.repo(),
          state: "open",
          labels: "ready to merge",
          sort: "created",
          direction: "asc",
        });

        updatedTrain = allIssues.data.filter((issue) => !!issue.pull_request).map((pr) => pr.number);
      }

      const latestStatusAndPR = await Promise.all(
        updatedTrain.map(async (pr) => {
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
            data: {
              number,
              labels,
              mergeable_state,
              head: { label: targetBranch },
            },
          },
        } = elem;

        const mergeLabel = labels.find((label) => label.name == "ready to merge");
        const anyPending = statuses.some((status) => status.state == "pending");

        if (enforceCodeFreeze && !targetBranch.includes(codeFreezeBranchName)) {
          log(context, `${number} is not pointing towards the code freeze branch. It will not be merged`);
        } else {
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
      }

      log(context, `after recalculating, train: [${updatedTrain}] becomes new train [${newTrain}]`);

      if (newTrain.length == readyToMerge.length) {
        log(context, `in train [${newTrain}] all PRs ready to merge`);
        await merge(context, newTrain);
        proposedTrain.splice(0);
      } else {
        log(context, `in train [${newTrain}] has [${readyToMerge}] ready to merge, some pending, waiting`);
        proposedTrain.splice(0, proposedTrain.length, ...newTrain);
      }
    } catch (e) {
      context.log.error(e);
    }
  };

  const checkSinglePr = async (pull_number: number, context: Context): Promise<void> => {
    try {
      // Short circuit if the PR has already been added to the train by another action.
      if (proposedTrain.includes(pull_number)) {
        return;
      }

      const {
        data: {
          number,
          labels,
          mergeable_state,
          head: { label: targetBranch },
        },
      } = await context.github.pulls.get({
        ...context.repo(),
        pull_number,
      });

      if (enforceCodeFreeze && !targetBranch.includes(codeFreezeBranchName)) {
        return log(context, `${number} is not pointing towards the code freeze branch. It will not be merged`);
      }

      const mergeLabel = labels.find((label) => label.name == "ready to merge");

      // if it's labeled and we're sure it can be merged...
      if (mergeLabel && mergeable_state == "clean") {
        // Add it to the proposed list
        proposedTrain.push(number);
        log(context, `${number} added to the proposed train: clean and ready to merge`);
      }
    } catch (e) {
      context.log.error(e);
    }
  };

  const logAndEnqueue = (
    job: ((context: Context) => Promise<void>) | (() => Promise<void>),
    type: string,
    context: Context
  ): void => {
    if (!enabled) {
      context.log("not enabled, bailing");
      return;
    }

    context.log(`enqueue at length ${queue.size}`);

    const requestDate = new Date();

    queue.add(async () => {
      decisionLog.splice(0);
      log(context, `request at: ${requestDate} processed at ${new Date()} event type ${type}`);
      await job(context);
      log(context, "request complete");
    });
  };

  return {
    proposedTrain,
    decisionLog,
    queue,
    get enabled(): boolean {
      return enabled;
    },
    set enabled(state) {
      enabled = state;
      // TODO rekick off a search by sending an event to ourselves
    },

    get mergingEnabled(): boolean {
      return mergingEnabled;
    },
    set mergingEnabled(state) {
      mergingEnabled = state;
    },

    on(action: string, context: Context): void {
      if (action === "status") {
        // it's tricky to figure out the branch from the sha.
        // just find the mergeability of all prs in the train every time
        // and rely on the fact that we cache the REST calls so it's not deathly
        // inefficient.
        logAndEnqueue(checkMergeTrain, "status", context);
      } else if (action === "pull_request.labeled") {
        const {
          label,
          pull_request: { number },
        } = context.payload;

        if (label.name == "ready to merge") {
          context.log(`PR labeled for merge ${number}`);
          logAndEnqueue(
            async () => {
              if (proposedTrain.length == 0) {
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
      } else if (action === "pull_request.unlabeled") {
        const {
          label,
          pull_request: { number },
        } = context.payload;

        if (label.name == "ready to merge") {
          logAndEnqueue(
            async () => {
              const index = proposedTrain.indexOf(number);
              if (index !== -1) {
                log(context, `PR ${number} was part of proposed train ${proposedTrain}, but was unlabeled. Removing`);
                proposedTrain.splice(index, 1);

                await checkMergeTrain(context);
              }
            },
            "unlabeled",
            context
          );
        }
      } else if (action === "ping") {
        // for testing.
      }
    },
  };
}

export = (cacheState: CacheState, config: Config): { repos: Repos; app: ApplicationFunction } => {
  const appRoute = config.appRoute || `/${config.appName}`;
  const repos: Repos = {};

  const mergeApp = (app: Application): void => {
    const getRepo = (context: Context): Repo => {
      const repoName = context.repo().repo;
      if (!repos[repoName]) {
        const newRepo = repo(config);
        repos[repoName] = newRepo;
      }

      return repos[repoName];
    };

    routes(cacheState, repos, appRoute, app.route(appRoute));

    ["ping", "status", "pull_request.labeled", "pull_request.unlabeled"].forEach((kind) =>
      app.on(kind, async (context: Context) => {
        getRepo(context).on(kind, context);
      })
    );
  };

  return {
    app: mergeApp,
    repos,
  };
};
