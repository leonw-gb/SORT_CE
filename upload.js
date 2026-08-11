// upload.js - Session upload to the recording server.
//
//   POST {base}/api/upload   multipart/form-data, field "file"
//   200/201 -> JSON with session_url (preferred), else watch_url / raw_url
//
// What travels is the .sortz BUNDLE, not the bare .webm. The server hosts the
// same timeline player the extension does, so uploading only the video would
// throw away the half of a session that explains it -- the event stream, the
// tab lanes, the SOP steps and who recorded it.
//
// The server does not authenticate uploads -- it is reachable only on the
// internal network -- so there is no key to send.
//
// XMLHttpRequest rather than fetch: it reports upload progress, and a bundle is
// hundreds of megabytes over the office network. This runs in the ticket
// window, never the service worker -- the worker can be torn down mid-upload,
// an open window cannot.

function uploadVideo({ baseUrl, blob, filename, onProgress }) {
  return new Promise((resolve, reject) => {
    const url = baseUrl.replace(/\/+$/, "") + "/api/upload";
    const form = new FormData();
    form.append("file", blob, filename);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.timeout = 30 * 60 * 1000;

    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onerror = () => reject(new Error(`Cannot reach the upload server at ${baseUrl}`));
    xhr.ontimeout = () => reject(new Error("The upload timed out"));
    xhr.onload = () => {
      if (xhr.status !== 200 && xhr.status !== 201) {
        reject(new Error(`Upload failed with HTTP ${xhr.status}`));
        return;
      }
      let data;
      try { data = JSON.parse(xhr.responseText); }
      catch (e) { reject(new Error("The upload server returned a response we cannot read")); return; }
      // session_url wins when the server can host a full session (timeline +
      // video). watch_url/raw_url are the video-only fallbacks it returns
      // today. Returning the shape rather than a bare string lets the caller
      // label the link correctly without sniffing the URL.
      // session_url is what the server returns for a bundle it could unpack:
      // a page with the timeline AND the video. watch_url/raw_url remain the
      // video-only answers, so an older server keeps working unchanged.
      const sessionUrl = data.session_url || "";
      const link = sessionUrl || data.watch_url || data.raw_url || "";
      if (!link) { reject(new Error("The upload finished but the server returned no link")); return; }
      resolve(sessionUrl ? { url: link, sessionUrl } : { url: link, sessionUrl: null });
    };
    xhr.send(form);
  });
}

if (typeof globalThis !== "undefined") globalThis.uploadVideo = uploadVideo;
