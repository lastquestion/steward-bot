import { Application, Context } from "probot"; // eslint-disable-line no-unused-vars
import { routes } from "./routes";
import { State } from "./state";
import PQueue from "p-queue";
import { CacheState } from "./cache";

// so we can test changes without mutating things
const MUTATE = !!process.env.MUTATE;
const DEBUG = !!process.env.DEBUG;

// because we expect that the number of requests we need to make is high,
// use the old REST API because we can use ETags to avoid hitting our
// rate limits

export = (cacheState: CacheState, app: Application): void => {
  let state: State = {
    proposedTrain: [],
    enabled: MUTATE,
    decisionLog: [],
    queue: new PQueue({ concurrency: 1 }),
    cacheState,
  };

  routes(state, "/merge", app.route("/merge"));

  const log = (context: Context, str: string) => {
    state.decisionLog.push(str);
    context.log(str);
  };

  const merge = async (context: Context, mergeTrain: Array<number>) => {
    if (mergeTrain.length == 0) return;

    log(context, `attempting to merge [${mergeTrain}]`);

    if (!MUTATE) {
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
            body: `This PR was merged by ot-probot. Thanks for your contribution.`,
          });

          return { pull_number: pr, mergeResult };
        } catch (err) {
          throw { pull_number: pr, err };
        }
      })
    );

    const successes = results
      .filter((result) => result.status == "fulfilled")
      .map((result: any) => result.value.pull_number);
    const failures = results
      .filter((result) => result.status == "rejected")
      .map((result: any) => result.reason.pull_number);

    log(context, `succeeded in merging [${successes}], failed to merge [${failures}]`);
    log(context, `failures reasons: ${JSON.stringify(failures)}`);
  };

  const checkMergeTrain = async (context: Context) => {
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

      if (DEBUG) console.log(JSON.stringify(latestStatusAndPR, null, "  "));

      const newTrain = [] as Array<number>;
      const readyToMerge = [] as Array<number>;

      for (const elem of latestStatusAndPR) {
        const {
          combinedStatus: {
            data: { state, statuses },
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
          `${number} from the merge train: ${state} pending checks: ${anyPending ? "pending" : "none pending"} label: ${
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
      context.log(e);
    }
  };

  const logAndEnqueue = (job: ((context: Context) => Promise<void>) | (() => Promise<void>), context: Context) => {
    if (!state.enabled) {
      context.log("not enabled, bailing");
      return;
    }

    context.log(`enqueue at length ${state.queue.size}`);

    const requestDate = new Date();

    state.queue.add(async () => {
      state.decisionLog = [];
      log(context, `request at: ${requestDate} processed at ${new Date()}`);
      await job(context);
      log(context, "request complete");
    });
  };

  app.on("status", async (context: Context) => {
    // it's tricky to figure out the branch from the sha.
    // just find the mergeability of all prs in the train every time
    // and rely on the fact that we cache the REST calls so it's not deathly
    // inefficient.
    logAndEnqueue(checkMergeTrain, context);
  });

  app.on("pull_request.labeled", async (context: Context) => {
    const {
      label,
      pull_request: { number },
    } = context.payload;

    if (label.name == "ready to merge") {
      context.log(`PR labeled for merge ${number}`);
      logAndEnqueue(async () => {
        if (state.proposedTrain.length == 0) {
          log(context, `PR ${number} labeled; proposed trains empty, starting`);
          await checkMergeTrain(context);
        }
      }, context);
    }
  });

  app.on("pull_request.unlabeled", async (context: Context) => {
    const {
      label,
      pull_request: { number },
    } = context.payload;

    if (label.name == "ready to merge") {
      logAndEnqueue(async () => {
        if (state.proposedTrain.indexOf(number) != -1) {
          log(context, `PR ${number} was part of proposed train ${state.proposedTrain}, but was unlabeled. Removing`);
          state.proposedTrain = state.proposedTrain.filter((id) => id != number);

          await checkMergeTrain(context);
        }
      }, context);
    }
  });
};
