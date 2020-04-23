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
<form method="post" action="${root}"><button name="enabled">Turn ${!enabled ? "on" : "off"}</button></form>
<form method="post" action="${root}"><button name="mergingEnabled">${
      !mergingEnabled ? "Unpause Merging" : "Pause Merging"
    }</button></form>
<pre>Log:
${decisionLog.join("\n")}
</pre>
</body>
</html>
`);
  });

  router.post("/", (req, res) => {
    const bodyChunks: Uint8Array[] = [];
    req
      .on("data", (chunk) => {
        bodyChunks.push(chunk);
      })
      .on("end", () => {
        const stateValue = Buffer.concat(bodyChunks).toString("utf8").split("=")[0];
        state[stateValue] = !state[stateValue];
        req.log(`changing ${stateValue} state to ${state[stateValue]}`);
        res.redirect(root);
      });
  });
}
