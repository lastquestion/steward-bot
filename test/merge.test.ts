/* eslint-disable @typescript-eslint/camelcase, @typescript-eslint/no-explicit-any */

import nock from "nock";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { Probot } from "probot";
import Merge from "../src/merge";
import { CacheState } from "../src/cache";
import { State } from "../src/state";

const readFile = promisify(fs.readFile);

const INSTALLATION_ID = 999;

function wrapIntoRequest(name: string, fixture: any): any {
  return {
    name,
    id: "1",
    payload: {
      ...fixture,
      installation: {
        id: INSTALLATION_ID,
      },
    },
  };
}

function fixtureIssueList(...pulls: Array<number>): any {
  return [
    ...pulls.map((pr) => ({
      pull_request: {},
      number: pr,
    })),
    {
      number: 9999,
      /* a random issue */
    },
  ];
}

function fixturePR({
  number,
  mergeable_state,
  labelled,
}: {
  number: number;
  mergeable_state: string;
  labelled: boolean;
}): any {
  const pr = {
    number,
    head: {
      sha: `pr-${number}-sha-head`,
    },
    labels: [
      {
        name: "unimportant",
      },
    ],
    mergeable_state,
  };

  if (labelled) {
    pr.labels.push({
      name: "ready to merge",
    });
  }

  return pr;
}

function fixtureRepository(id = "1234", name = "repo-name"): any {
  return {
    repository: {
      id,
      name,
      owner: {
        login: "repo-owner",
      },
    },
  };
}

function fixtureRequestStatus(): any {
  return wrapIntoRequest("status", {
    state: "success",
    commit: {},
    ...fixtureRepository(),
  });
}

function fixtureCombinedStatus(...states: Array<string>): any {
  return {
    statuses: states.map((state) => ({
      state,
    })),
  };
}

describe("steward-bot: merge", () => {
  let probot: Probot;
  let mockCert: string;
  let cacheState: CacheState;
  let appState: State;

  beforeAll(async () => {
    mockCert = await readFile(path.join(__dirname, "fixtures/mock-cert.pem"), "utf8");

    nock.disableNetConnect();

    // there is no good way to configure @octokit/retry from probot, which means
    // we cannot add the 500 error code from nock into list of not-retried requests, nor change the retry speed / count.
    // nor can we adjust nock to return a different code when failing to match.
    // all we can do is print a very loud error:
    nock.emitter.on("no match", (req: any) => {
      console.error(`Nock failed to match ${req.method} ${req.path}, did you forget a nock??`);
    });

    console.log("ignore the following deprecation about auth, see https://github.com/probot/probot/issues/1139");
  });

  beforeEach(() => {
    probot = new Probot({ id: 1, cert: mockCert });

    const app = Merge(cacheState, { mutate: true, debug: false, appName: "steward-bot" });
    appState = app.state;

    probot.load(app.app);

    nock("https://api.github.com")
      .post(`/app/installations/${INSTALLATION_ID}/access_tokens`)
      .reply(200, { token: "atoken" });
  });

  describe("status change", () => {
    test("enqueues multiple requests", async () => {
      appState.queue.pause();
      await probot.receive(fixtureRequestStatus());
      await probot.receive(fixtureRequestStatus());
      expect(appState.queue.size).toBe(2);
    });

    test("it asks for pull requests, and does nothing if empty", async () => {
      nock("https://api.github.com")
        .get("/repos/repo-owner/repo-name/issues?state=open&labels=ready%20to%20merge&sort=created&direction=asc")
        .reply(200, []);

      await probot.receive(fixtureRequestStatus());
      await appState.queue.onIdle();
    });

    test("it asks for pull requests, and checks to see if any are ready", async () => {
      nock("https://api.github.com")
        .get("/repos/repo-owner/repo-name/issues?state=open&labels=ready%20to%20merge&sort=created&direction=asc")
        .reply(200, fixtureIssueList(1347));

      nock("https://api.github.com")
        .get("/repos/repo-owner/repo-name/pulls/1347")
        .reply(200, fixturePR({ number: 1347, mergeable_state: "unknown", labelled: true }));

      nock("https://api.github.com")
        .get("/repos/repo-owner/repo-name/commits/pr-1347-sha-head/status")
        .reply(200, { statuses: [] });

      await probot.receive(fixtureRequestStatus());
      await appState.queue.onIdle();

      expect(appState.proposedTrain).toEqual([]);
    });

    test("it asks for pull requests, and waits if status is pending", async () => {
      nock("https://api.github.com")
        .get("/repos/repo-owner/repo-name/issues?state=open&labels=ready%20to%20merge&sort=created&direction=asc")
        .reply(200, fixtureIssueList(1347));

      nock("https://api.github.com")
        .get("/repos/repo-owner/repo-name/pulls/1347")
        .reply(200, fixturePR({ number: 1347, mergeable_state: "unknown", labelled: true }));

      nock("https://api.github.com")
        .get("/repos/repo-owner/repo-name/commits/pr-1347-sha-head/status")
        .reply(200, fixtureCombinedStatus("pending"));

      await probot.receive(fixtureRequestStatus());
      await appState.queue.onIdle();

      expect(appState.proposedTrain).toEqual([1347]);
    });

    test("it attempts to merge if the PR is mergeable and clean", async () => {
      nock("https://api.github.com")
        .get("/repos/repo-owner/repo-name/issues?state=open&labels=ready%20to%20merge&sort=created&direction=asc")
        .reply(200, fixtureIssueList(1347));

      nock("https://api.github.com")
        .get("/repos/repo-owner/repo-name/pulls/1347")
        .reply(200, fixturePR({ number: 1347, mergeable_state: "clean", labelled: true }));

      nock("https://api.github.com")
        .get("/repos/repo-owner/repo-name/commits/pr-1347-sha-head/status")
        .reply(200, fixtureCombinedStatus("success"));

      nock("https://api.github.com")
        .put("/repos/repo-owner/repo-name/pulls/1347/merge", {
          merge_method: "squash",
        })
        .reply(200, {});

      nock("https://api.github.com").post("/repos/repo-owner/repo-name/issues/1347/comments").reply(200, {
        body: "This PR was merged by steward-bot. Thanks for your contribution",
      });

      await probot.receive(fixtureRequestStatus());
      await appState.queue.onIdle();
      expect(appState.proposedTrain).toEqual([]);
    });
  });

  describe("pullrequest.labeled", () => {
    test("restarts the train if there is no train and the label is mergeable", async () => {
      nock("https://api.github.com")
        .get("/repos/repo-owner/repo-name/issues?state=open&labels=ready%20to%20merge&sort=created&direction=asc")
        .reply(200, fixtureIssueList(166));

      nock("https://api.github.com")
        .get("/repos/repo-owner/repo-name/pulls/166")
        .reply(200, fixturePR({ number: 166, mergeable_state: "unknown", labelled: true }));

      nock("https://api.github.com")
        .get("/repos/repo-owner/repo-name/commits/pr-166-sha-head/status")
        .reply(200, fixtureCombinedStatus("pending"));

      await probot.receive(
        wrapIntoRequest("pull_request.labeled", {
          pull_request: {
            number: 166,
          },
          label: {
            name: "ready to merge",
          },
          ...fixtureRepository(),
        })
      );

      await appState.queue.onIdle();
      expect(appState.proposedTrain).toEqual([166]);
    });

    test("does nothing if the train is already running", async () => {
      appState.proposedTrain = [123];
      await probot.receive(
        wrapIntoRequest("pull_request.labeled", {
          pull_request: {
            number: 166,
          },
          label: {
            name: "ready to merge",
          },
          ...fixtureRepository(),
        })
      );

      await appState.queue.onIdle();
      expect(appState.proposedTrain).toEqual([123]);
    });
  });

  afterEach(() => {
    nock.cleanAll();
    nock.abortPendingRequests();
  });

  afterAll(() => {
    nock.enableNetConnect();
    nock.restore(); //https://github.com/nock/nock/issues/1817
  });
});
