import { Router } from "express";
import { State } from "./state";
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

export function routes(state: State, root: string, router: Router): void {
  router.use(bodyParser.urlencoded());

  router.get("/", (_req, res) => {
    const { enabled, mergingEnabled, proposedTrain, decisionLog } = state;
    res.send(`
<html>
<body>
<pre>
proposed PRs: ${JSON.stringify(proposedTrain)}
enabled: ${enabled ? "yes" : "no"}
merging: ${mergingEnabled ? "enabled" : "disabled"}
queue length: ${state.queue.size}
lru cache size: ${state.cacheState.lru.size}
rate limit remaining: ${state.cacheState.remainingLimit} out of ${state.cacheState.rateLimit}
</pre>
<form method="post" action="${root}">
<button name="enabled" value="enabled">Turn ${!enabled ? "on" : "off"}</button>
<button name="mergingEnabled" value="mergingEnabled">${!mergingEnabled ? "Unpause Merging" : "Pause Merging"}</button>
</form>
<pre>Log:
${decisionLog.join("\n")}
</pre>
</body>
</html>
`);
  });
  router.post("/", (req, res) => {
    const { enabled, mergingEnabled } = req.body;
    if (enabled) {
      state.enabled = !state.enabled;
      req.log(`changing enabled state to ${state.enabled}`);
    } else if (mergingEnabled) {
      state.mergingEnabled = !state.mergingEnabled;
      req.log(`changing mergingEnabled state to ${state.mergingEnabled}`);
    }
    res.redirect(root);
  });
}
