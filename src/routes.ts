import { Router } from "express";
import { State } from "./state";

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
  router.get("/", (_req, res) => {
    const { enabled, proposedTrain, decisionLog } = state;
    res.send(`
<html>
<body>
<pre>
proposed PRs: ${JSON.stringify(proposedTrain)}
enabled: ${enabled ? "yes" : "no"}
queue length: ${state.queue.size}
lru cache size: ${state.cacheState.lru.size}
rate limit remaining: ${state.cacheState.remainingLimit} out of ${state.cacheState.rateLimit}
</pre>
<form method="post" action="${root}"><button>Turn ${!enabled ? "on" : "off"}</button></form>
<pre>Log:
${decisionLog.join("\n")}
</pre>
</body>
</html>
`);
  });

  router.post("/", (req, res) => {
    state.enabled = !state.enabled;
    req.log(`changing enabled state to ${state.enabled}`);
    res.redirect(root);
  });
}
