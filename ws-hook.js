// ws-hook.js - runs in the PAGE (MAIN) world at document_start, BEFORE any
// page script. It wraps the native WebSocket so NiceGUI / Socket.IO frames can
// be recorded. It never modifies traffic - it only relays frames up to the
// content script via postMessage. Payloads are truncated to keep recordings
// a sane size.
//
// Design notes:
//  * Registered as a MAIN-world content script (see manifest) so window.WebSocket
//    is replaced synchronously before NiceGUI ever constructs its socket.
//  * Two layers of wrapping for safety:
//      1. Constructor wrap -> catches every socket created after we load.
//      2. Prototype-level send/addEventListener wrap -> also catches a socket
//         that some bundler cached a reference to before our constructor swap.
//  * Frames are BUFFERED from page load. The content script sends a
//    "__mtrWsStart" message when the expert presses Start; we then flush the
//    buffer and stream live. On "__mtrWsStop" we go back to buffering-only.
(function () {
  if (window.__mtrWsHookInstalled) return;
  window.__mtrWsHookInstalled = true;

  // ---- Canvas capture enabler (Flutter CanvasKit / WebGL apps) -------------
  // rrweb snapshots canvases by reading their pixels; a WebGL context created
  // WITHOUT preserveDrawingBuffer:true returns blank/black on readback, which
  // makes Flutter CanvasKit replays a black screen. Wrap getContext before any
  // app script runs (we are MAIN world @ document_start) so every WebGL
  // context keeps its drawing buffer readable.
  try {
    var origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      try {
        if (typeof type === "string" && type.indexOf("webgl") === 0) {
          attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
        }
      } catch (e) { /* never let our tweak break the host getContext */ }
      return origGetContext.call(this, type, attrs);
    };
  } catch (e) { /* ignore */ }

  var MAX = 8000;          // max chars of a single frame to relay
  var BUFFER_CAP = 2000;   // max frames to hold before Start is pressed
  var recording = false;
  var buffer = [];

  function serialize(data) {
    try {
      if (typeof data === "string") {
        return data.length > MAX ? data.slice(0, MAX) + "\u2026[truncated]" : data;
      }
      if (data instanceof ArrayBuffer) return "[binary " + data.byteLength + " bytes]";
      if (data && data.byteLength != null) return "[binary " + data.byteLength + " bytes]";
      if (data && typeof data === "object" && data.size != null) return "[blob " + data.size + " bytes]";
      return String(data);
    } catch (e) {
      return "[unserializable]";
    }
  }

  function relay(direction, url, payload) {
    var frame = {
      __mtrWs: true,
      direction: direction,
      url: url || null,
      payload: serialize(payload),
      ts: Date.now()
    };
    if (recording) {
      try { window.postMessage(frame, "*"); } catch (e) {}
    } else {
      buffer.push(frame);
      if (buffer.length > BUFFER_CAP) buffer.shift();
    }
  }

  function flushBuffer() {
    var pending = buffer.splice(0, buffer.length);
    for (var i = 0; i < pending.length; i++) {
      pending[i].buffered = true;
      try { window.postMessage(pending[i], "*"); } catch (e) {}
    }
  }

  // Content-script control channel: start/stop recording of WS frames.
  window.addEventListener("message", function (e) {
    if (!e.data || e.source !== window) return;
    if (e.data.__mtrWsControl === "start") {
      recording = true;
      flushBuffer();
      // Confirm the hook is alive so the recorder can log wsBridgeStatus.
      try { window.postMessage({ __mtrWsStatus: true, installed: true }, "*"); } catch (err) {}
    } else if (e.data.__mtrWsControl === "stop") {
      recording = false;
    }
  });

  var NativeWS = window.WebSocket;
  if (!NativeWS) return;

  // ---- Layer 1: constructor wrap ------------------------------------------
  function WrappedWS(url, protocols) {
    var ws = arguments.length <= 1 ? new NativeWS(url) : new NativeWS(url, protocols);
    instrument(ws, url);
    return ws;
  }
  WrappedWS.prototype = NativeWS.prototype;
  WrappedWS.CONNECTING = NativeWS.CONNECTING;
  WrappedWS.OPEN = NativeWS.OPEN;
  WrappedWS.CLOSING = NativeWS.CLOSING;
  WrappedWS.CLOSED = NativeWS.CLOSED;

  function instrument(ws, url) {
    try {
      if (ws.__mtrInstrumented) return;
      ws.__mtrInstrumented = true;

      var nativeSend = ws.send.bind(ws);
      ws.send = function (data) {
        try { relay("send", url || ws.url, data); } catch (e) {}
        return nativeSend(data);   // ALWAYS forward - never break the app socket
      };
      ws.addEventListener("message", function (ev) {
        try { relay("receive", url || ws.url, ev.data); } catch (e) {}
      });
    } catch (e) { /* instrumentation must never break the host socket */ }
  }

  try {
    window.WebSocket = WrappedWS;
  } catch (e) { /* reassignment blocked - prototype layer still helps */ }

  // ---- Layer 2: prototype wrap (catches pre-existing/cached sockets) -------
  try {
    var protoSend = NativeWS.prototype.send;
    NativeWS.prototype.send = function (data) {
      try {
        if (!this.__mtrInstrumented) {
          // A socket we never saw constructed - relay its outgoing too.
          relay("send", this.url, data);
        }
      } catch (e) { /* never break the host send */ }
      return protoSend.apply(this, arguments);
    };
    var protoAdd = NativeWS.prototype.addEventListener;
    // (message listeners on pre-existing sockets are added by the app itself;
    //  we passively tap outgoing via the send wrap above.)
  } catch (e) { /* ignore */ }
})();
