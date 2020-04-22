import { Probot, Application, ApplicationFunction } from "probot";
import { ProbotOctokit } from "probot/lib/github";

import { CachePlugin } from "./cache";
import app from "./merge";

// it would be great if we can customize options in probot.run
// so we can install the caching plugin easier, but as we can't
// let's just monkey patch so we can still use the full startup
// machinery including finding private keys

const cache = CachePlugin({ maxSize: 1000 });

// need to cast the plugin for cache because the probot one has
// extra fields
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cachedOctokit = ProbotOctokit.plugin(cache.plugin as any);

const config = {
  mutate: !!process.env.MUTATE,
  debug: !!process.env.DEBUG,
  appName: process.env.BOTNAME || "steward-bot",
};

Probot.prototype.load = ((originalLoad) => {
  // tell us who you are
  console.log('I AM THE EVIL MERGE BOT OF DOOOOOOM!!! FEAR ME WHILE I MERGE YOUR PRS!!!');

  // cast away...
  return function (this: Probot, app: string | ApplicationFunction): Application {
    //eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).Octokit = cachedOctokit;
    return originalLoad.call(this, app);
  };
})(Probot.prototype.load);

(async (): Promise<void> => {
  // this is also kind of ganky. This would be fixed if we can
  // use the setup() code while loading a function.

  const probot = await Probot.run(process.argv);
  probot.load(app(cache.state, config).app);
})();
