// upload.js - Session upload to the recording server.
//
// A bundle goes to the SESSION endpoint, which knows what a .sortz is:
//
//   POST {base}/api/session   multipart/form-data, field "bundle"
//   201 -> { session_url, raw_url, expires_at }
//
// Not /api/upload with field "file": that is the old VIDEO endpoint. It takes
// a bare .webm, rejects anything else, and answered a bundle with HTTP 400 --
// which is why the same file uploaded by hand through the server's own page
// worked while the extension could not. The two differ in both the path and
// the field name, so neither alone was enough.
//
// A server that predates session hosting has no /api/session and answers 404.
// That case falls back to the old endpoint so an un-upgraded server keeps
// working, with the video-only link it can produce.
//
// The server does not authenticate uploads -- it is reachable only on the
// internal network -- so there is no key to send.
//
// XMLHttpRequest rather than fetch: it reports upload progress, and a bundle is
// hundreds of megabytes over the office network. This runs in the ticket
// window, never the service worker -- the worker can be torn down mid-upload,
// an open window cannot.

function postBundle({ url, field, blob, filename, onProgress }) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append(field, blob, filename);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.timeout = 30 * 60 * 1000;

    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onerror = () => reject(Object.assign(new Error(`Cannot reach the upload server at ${url}`), { network: true }));
    xhr.ontimeout = () => reject(new Error("The upload timed out"));
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }

      if (xhr.status !== 200 && xhr.status !== 201) {
        // The server explains its refusals in an "error" field. Passing that
        // through turns "HTTP 400" into something the operator can act on.
        const detail = (data && data.error) || (xhr.responseText || "").slice(0, 200);
        reject(Object.assign(
          new Error(detail ? `The server refused the upload: ${detail}` : `Upload failed with HTTP ${xhr.status}`),
          { status: xhr.status }
        ));
        return;
      }
      if (!data) { reject(new Error("The upload server returned a response we cannot read")); return; }
      resolve(data);
    };
    xhr.send(form);
  });
}

async function uploadVideo({ baseUrl, blob, filename, onProgress }) {
  const base = baseUrl.replace(/\/+$/, "");

  let data;
  try {
    data = await postBundle({
      url: `${base}/api/session`, field: "bundle", blob, filename, onProgress
    });
  } catch (e) {
    // Only a missing endpoint justifies the fallback. A 400 from the session
    // endpoint is a real complaint about this bundle and must be shown, not
    // retried against an endpoint that will reject it too.
    if (e.status !== 404 && e.status !== 405) throw e;
    data = await postBundle({
      url: `${base}/api/upload`, field: "file", blob, filename, onProgress
    });
  }

  // session_url is a page with the timeline AND the video. watch_url/raw_url
  // are the video-only answers an older server gives.
  const sessionUrl = data.session_url || "";
  const link = sessionUrl || data.watch_url || data.raw_url || "";
  if (!link) throw new Error("The upload finished but the server returned no link");
  return { url: link, sessionUrl: sessionUrl || null };
}

if (typeof globalThis !== "undefined") globalThis.uploadVideo = uploadVideo;
