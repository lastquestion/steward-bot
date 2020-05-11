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
    let page = `
<html>
<body>
<pre>
`;
    for (const repo of Object.keys(repos)) {
      const { enabled, mergingEnabled, proposedTrain, decisionLog, queue } = repos[repo];
      page += `
repo ${repo}
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
}
