import { Probot } from "probot";
import { ProbotOctokit } from "probot/lib/github";

import { CachePlugin } from "./cache";
import app from "./merge";

// it would be great if we can customize options in probot.run
// so we can install the caching plugin easier, but as we can't
// let's just monkey patch so we can still use the full startup
// machinery including finding private keys

const cache = CachePlugin({ maxSize: 1000 });
const cachedOctokit = ProbotOctokit.plugin(cache.plugin as any);

Probot.prototype.load = ((originalLoad) => {
  // cast away...
  return function (this: Probot, app: any) {
    (this as any).Octokit = cachedOctokit;
    return originalLoad.call(this, app);
  };
})(Probot.prototype.load);

(async () => {
  // this is also kind of ganky. This would be fixed if we can
  // use the setup() code while loading a function.

  const probot = await Probot.run(process.argv);
  probot.load(app.bind(null, cache.state));
})();
