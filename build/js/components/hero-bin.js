// The point cloud's binary, fetched. Imports nothing — hero-mount.js needs this on the
// no-GPU path, where the whole point is NOT to download three on the main thread.

export async function loadCloudBuffer(binUrl) {
  // A plain fetch, deliberately. This used to force revalidation with
  // `{cache: 'no-cache'}`, from when the binary was served under a fixed name and
  // a swapped-in cloud would otherwise keep rendering the old one out of cache.
  // The filename carries a content hash now, so a new binary is a new URL and
  // there is nothing stale to catch — while the revalidation itself would defeat
  // the <link rel="preload"> in head.twig, which is the whole point of preloading
  // 373kB that a dynamic import can't even ask for until it has parsed.
  // Mode and credentials have to keep matching that preload's `crossorigin`.
  //
  // THE COMPRESSED COPY FIRST. The build writes a .gz beside the binary (see
  // vite.config.js) because nothing compresses it in flight — gzip is selected by
  // content type, and application/octet-stream is in no sensible gzip_types list.
  // 373kB becomes 291kB, and the inflating costs a few milliseconds off the main
  // thread in a stream.
  //
  // Falls back to the raw binary if DecompressionStream is missing (Safari before
  // 16.4) or the .gz is not there — an older build, or a deploy that copied only the
  // files it recognised. The fallback is the file that was always being fetched, so
  // the worst case is exactly today's behaviour.
  const buf = await (async () => {
      if (typeof DecompressionStream === "function") {
          try {
              const gz = await fetch(binUrl + ".gz");
              if (gz.ok) {
                  return await new Response(
                      gz.body.pipeThrough(new DecompressionStream("gzip")),
                  ).arrayBuffer();
              }
          } catch (e) {
              // fall through to the plain binary
          }
      }

      return (await fetch(binUrl)).arrayBuffer();
  })();
  return buf;
}
