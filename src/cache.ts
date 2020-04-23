import { Octokit } from "@octokit/core";

import QuickLRU from "quick-lru";

interface CacheItem {
  etag: string;
  response: any; //eslint-disable-line @typescript-eslint/no-explicit-any
}

export type CacheState = {
  lru: QuickLRU<string, CacheItem>;
  rateLimit: string;
  remainingLimit: string;
};

function cache(state: CacheState, octokit: Octokit): void {
  // we should actually use octokit.log. It's a bug in probot.
  const logger = {
    debug: (str: string): void => console.log(str),
  };

  octokit.hook.wrap("request", (request, options) => {
    const requestOptions = octokit.request.endpoint.parse(options);

    const { url } = requestOptions;
    const { method, headers } = options;

    let cachedResponse: CacheItem | undefined;

    if (method == "GET") {
      cachedResponse = state.lru.get(url);
      if (cachedResponse) {
        logger.debug(`cache: etag found for ${url} ${cachedResponse.etag}`);
        headers["If-None-Match"] = cachedResponse.etag;
      }
    }

    return (
      request(options)
        //eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((response: any) => {
          const {
            headers: { etag, "x-ratelimit-limit": rateLimit, "x-ratelimit-remaining": remainingLimit },
          } = response;

          state.rateLimit = rateLimit;
          state.remainingLimit = remainingLimit;

          if (etag) {
            logger.debug(`cache: storing ${etag} for ${url}`);
            state.lru.set(url, { etag, response });
          }

          return response;
        })
        //eslint-disable-next-line @typescript-eslint/no-explicit-any
        .catch((error: any) => {
          if (error.status === 304) {
            if (cachedResponse) {
              logger.debug(`cache: hit 304 for ${cachedResponse.etag} ${url}`);
              return cachedResponse.response;
            }
          }

          throw error;
        })
    );
  });
}

export function CachePlugin({
  maxSize,
}: {
  maxSize: number;
}): { state: CacheState; plugin: (octokit: Octokit) => void } {
  const state = {
    lru: new QuickLRU<string, CacheItem>({ maxSize }),
    remainingLimit: "",
    rateLimit: "",
  };

  return {
    state,
    plugin: cache.bind(null, state),
  };
}
