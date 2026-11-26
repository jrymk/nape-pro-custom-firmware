import { validateImage } from "./public/maintenance.js";

const repo = "jrymk/nape-pro-custom-firmware";
const maxSize = 0x59000;
const names = {
  custom: /^np-custom-firmware-\d+\.\d+\.\d+\.bin$/i,
  stock: /^Keychron-Nape-Pro-\d+\.\d+\.\d+\.bin$/i,
};

// Only public release downloads from this repository. No uploads or arbitrary URLs.
export async function releaseDownload(request, cache) {
  const url = new URL(request.url);
  const kind = url.pathname.match(/^\/api\/firmware\/(custom|stock)$/)?.[1];
  if (!kind) return new Response("Not found", { status: 404 });
  if (request.method !== "GET")
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET" },
    });
  const cacheKey = new Request(`${url.origin}${url.pathname}`);
  const cached = await cache?.match(cacheKey);
  if (cached) return cached;
  try {
    // The public latest redirect avoids GitHub API's shared-IP quota on Workers.
    const latest = await fetch(`https://github.com/${repo}/releases/latest`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    const location = latest.headers.get("Location") || "";
    const tagPrefix = `https://github.com/${repo}/releases/tag/`;
    if (latest.status !== 302 || !location.startsWith(tagPrefix))
      throw Error(
        "Latest GitHub release is unavailable. Choose a local file or retry later.",
      );
    const tag = decodeURIComponent(location.slice(tagPrefix.length));
    const listing = await fetch(
      `https://github.com/${repo}/releases/expanded_assets/${encodeURIComponent(tag)}`,
      {
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!listing.ok)
      throw Error(
        "GitHub release assets are unavailable. Choose a local file or retry.",
      );
    const html = await listing.text();
    const prefix = `/${repo}/releases/download/${encodeURIComponent(tag)}/`;
    const candidates = [
      ...new Set(
        [...html.matchAll(/href="([^"]+)"/g)]
          .map((match) => match[1])
          .filter((href) => href.startsWith(prefix))
          .map((href) => decodeURIComponent(href.slice(prefix.length)))
          .filter((name) => names[kind].test(name)),
      ),
    ];
    if (candidates.length !== 1)
      throw Error(
        `The latest release must contain exactly one ${kind} application .bin. Choose a local file instead.`,
      );
    const name = candidates[0];
    const download = await fetch(
      `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
      { signal: AbortSignal.timeout(30000) },
    );
    if (!download.ok || !download.body)
      throw Error(
        "GitHub could not download the firmware. Choose a local file or retry.",
      );
    const declaredSize = download.headers.get("Content-Length");
    if (
      declaredSize !== null &&
      (!Number.isInteger(Number(declaredSize)) ||
        Number(declaredSize) < 4096 ||
        Number(declaredSize) > maxSize)
    )
      throw Error(
        "The release asset is not an application-sized firmware image.",
      );
    const reader = download.body.getReader();
    const buffer = new Uint8Array(maxSize);
    let offset = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > maxSize) {
        await reader.cancel();
        throw Error("Release download exceeds the application size limit.");
      }
      buffer.set(value, offset);
      offset += value.length;
    }
    if (declaredSize !== null && offset !== Number(declaredSize))
      throw Error("Incomplete release download. Please retry.");
    const bytes = buffer.slice(0, offset);
    await validateImage(bytes, { stock: kind === "stock" });
    const response = new Response(bytes, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.length),
        "Content-Disposition": `attachment; filename="${name}"`,
        "X-Firmware-Name": name,
        "X-Firmware-Release": encodeURIComponent(tag),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=300",
      },
    });
    await cache?.put(cacheKey, response.clone());
    return response;
  } catch (error) {
    return Response.json(
      { error: error.message },
      {
        status: 502,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }
}
