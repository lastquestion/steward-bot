import { Router } from "express";
import { Repos } from "./repo";
import { CacheState } from "./cache";

import bodyParser from "body-parser";

declare global {
  //eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // added by probot
      log(msg: string): void;
    }
  }
}

export function routes(cacheState: CacheState, repos: Repos, root: string, router: Router): void {
  router.use(bodyParser.urlencoded());

  router.get("/", (_req, res) => {
    // NOTE: assumes all repos are in sync for code freeze status. This is set up to ONLY allow changing all repos at once.
    const firstRepo = repos[Object.keys(repos)[0]];
    let page = `
<html>
<body>
<h1>Merge Bot Settings</h1>
<strong>Code freeze status: ${firstRepo ? firstRepo.enforceCodeFreeze : "No repos configured"}</strong>
<br/>
<span style="color:red;font-weight:bold;">Warning: This affects ALL repositories using the PR Bot. Notify all repository owners before you enforce code freeze</span>
<form method="post" action="${root}/all/codeFreeze">
<button name="enforceCodeFreeze">${
      firstRepo && firstRepo.enforceCodeFreeze ? "Disable code freeze enforcement" : "Enforce code freeze"
    }</button>
<input name="codeFreezeBranchName">
<br/>
current enforced branch: ${firstRepo ? firstRepo.codeFreezeBranchName : ""}
</form>
<br/>
<pre>
`;

    for (const repo of Object.keys(repos)) {
      const { enabled, mergingEnabled, proposedTrain, decisionLog, queue } = repos[repo];
      page += `
<strong> repo ${repo} </strong>
proposed PRs: ${JSON.stringify(proposedTrain)}
enabled: ${enabled ? "yes" : "no"}
merging: ${mergingEnabled ? "enabled" : "disabled"}
queue length: ${queue.size}
</pre>
<form method="post" action="${root}">
<input type="hidden" value="${repo}" name="repo">
<button name="enabled" value="enabled">Turn ${!enabled ? "on" : "off"}</button>
<button name="mergingEnabled" value="mergingEnabled">${!mergingEnabled ? "Unpause Merging" : "Pause Merging"}</button>
</form>
<pre>Log:
${decisionLog.join("\n")}
</pre>
`;
    }
    page += `
<pre>
lru cache size: ${cacheState.lru.size}
rate limit remaining: ${cacheState.remainingLimit} out of ${cacheState.rateLimit}
</pre>
</body>
</html>
`;
    res.send(page);
  });
  router.post("/", (req, res) => {
    const { enabled, mergingEnabled, repo: repoName } = req.body;
    const repo = repos[repoName];
    if (enabled) {
      repo.enabled = !repo.enabled;
      req.log(`changing enabled repo to ${repo.enabled} for ${repoName}`);
    } else if (mergingEnabled) {
      repo.mergingEnabled = !repo.mergingEnabled;
      req.log(`changing mergingEnabled repo to ${repo.mergingEnabled} for ${repoName}`);
    }
    res.redirect(root);
  });
  router.post("/:repoName/codeFreeze", (req, res) => {
    const { codeFreezeBranchName } = req.body;
    const { repoName } = req.params;

    if (repoName === "all") {
      Object.keys(repos).forEach((repoName) => {
        repos[repoName].enforceCodeFreeze = !repos[repoName].enforceCodeFreeze;
        repos[repoName].codeFreezeBranchName = codeFreezeBranchName;
      });
      if (Object.keys(repos).length)
        req.log(
          `changed all repository enforceCodeFreeze values to ${!repos[repoName]
            .enforceCodeFreeze} and changed the code freeze branch name to ${codeFreezeBranchName}`
        );
    }

    res.redirect(root);
  });
}
