// upload.js - Video upload to the recording server.
//
// Same contract the desktop tool used:
//   POST {base}/api/upload   multipart/form-data, field "file"
//   200/201 -> JSON with watch_url (preferred) or raw_url
//
// The server does not authenticate uploads -- it is reachable only on the
// internal network -- so there is no key to send.
//
// XMLHttpRequest rather than fetch: it reports upload progress, and a session
// video is hundreds of megabytes over the office network. This runs in the
// ticket window, never the service worker -- the worker can be torn down
// mid-upload, an open window cannot.

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
      const link = data.watch_url || data.raw_url || "";
      if (!link) { reject(new Error("The upload finished but the server returned no link")); return; }
      resolve(link);
    };
    xhr.send(form);
  });
}

if (typeof globalThis !== "undefined") globalThis.uploadVideo = uploadVideo;
