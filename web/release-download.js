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
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
  const cacheKey = new Request(`${url.origin}${url.pathname}`);
  const cached = await cache?.match(cacheKey);
  if (cached) return cached;
  try {
    const releaseResponse = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Nape-Studio" },
      signal: AbortSignal.timeout(15000),
    });
    if (!releaseResponse.ok)
      throw Error(releaseResponse.status === 404
        ? "No published stable release is available yet. Choose a local file instead."
        : "GitHub releases are unavailable or rate limited. Try again later or choose a local file.");
    const release = await releaseResponse.json();
    if (release.draft || release.prerelease || typeof release.tag_name !== "string")
      throw Error("No published stable release is available.");
    const candidates = (release.assets || []).filter(a => names[kind].test(a.name));
    if (candidates.length !== 1)
      throw Error(`The latest release must contain exactly one ${kind} application .bin. Choose a local file instead.`);
    const asset = candidates[0];
    if (!Number.isInteger(asset.size) || asset.size < 4096 || asset.size > maxSize)
      throw Error("The release asset is not an application-sized firmware image.");
    const download = await fetch(
      `https://github.com/${repo}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(asset.name)}`,
      { signal: AbortSignal.timeout(30000) },
    );
    if (!download.ok || !download.body) throw Error("GitHub could not download the firmware. Choose a local file or retry.");
    const reader = download.body.getReader();
    const bytes = new Uint8Array(asset.size);
    let offset = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > bytes.length) {
        await reader.cancel();
        throw Error("Release download exceeds its declared size.");
      }
      bytes.set(value, offset);
      offset += value.length;
    }
    if (offset !== bytes.length) throw Error("Incomplete release download. Please retry.");
    const info = await validateImage(bytes, { stock: kind === "stock" });
    if (asset.digest && asset.digest !== `sha256:${info.sha256}`)
      throw Error("Release asset checksum mismatch.");
    const response = new Response(bytes, { headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${asset.name}"`,
      "X-Firmware-Name": asset.name,
      "X-Firmware-Release": encodeURIComponent(release.tag_name),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=300",
    } });
    await cache?.put(cacheKey, response.clone());
    return response;
  } catch (error) {
    return Response.json({ error: error.message }, {
      status: 502, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
}
