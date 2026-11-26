import { releaseDownload } from "./release-download.js";

export default {
  fetch(request, env) {
    if (new URL(request.url).pathname.startsWith("/api/"))
      return releaseDownload(request, caches.default);
    return env.ASSETS.fetch(request);
  },
};
