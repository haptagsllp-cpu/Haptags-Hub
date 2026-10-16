/*
 * Haptags Hub: meeting background effects (blur and replacement), all on the user's device.
 * MediaPipe's selfie segmenter finds the person in each camera frame; we draw the background
 * (blurred video or an image) and the person on top into a canvas, and send the canvas stream.
 */
(function () {
  'use strict';

  var BASE = '/static/vendor/mediapipe';
  var MODEL = '/static/vendor/selfie_segmenter.tflite';
  var FPS = 24;
  var segmenter = null;
  var loading = null;

  /** Canvas filters are what make blur cheap; Safari doesn't support them, so effects are off there. */
  var supported = (function () {
    try {
      var c = document.createElement('canvas').getContext('2d');
      return Boolean(c && 'filter' in c && window.WebAssembly && HTMLCanvasElement.prototype.captureStream && window.Worker);
    } catch (e) { return false; }
  })();

  function load() {
    if (loading) return loading;
    loading = import(BASE + '/vision_bundle.mjs').then(function (vision) {
      return vision.FilesetResolver.forVisionTasks(BASE + '/wasm').then(function (files) {
        var opts = function (delegate) {
          return {
            baseOptions: { modelAssetPath: MODEL, delegate: delegate },
            runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true,
          };
        };
        return vision.ImageSegmenter.createFromOptions(files, opts('GPU'))
          .catch(function () { return vision.ImageSegmenter.createFromOptions(files, opts('CPU')); });
      });
    }).then(function (s) { segmenter = s; return s; });
    loading.catch(function () { loading = null; });
    return loading;
  }

  // ---- Built-in backgrounds, painted on the fly so there are no image files to ship ----
  var W = 1280; var H = 720;
  function paint(fn) {
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    fn(c.getContext('2d'));
    return c;
  }
  function grad(ctx, stops, x0, y0, x1, y1) {
    var g = ctx.createLinearGradient(x0 || 0, y0 || 0, x1 === undefined ? 0 : x1, y1 === undefined ? H : y1);
    stops.forEach(function (s) { g.addColorStop(s[0], s[1]); });
    return g;
  }
  var PRESETS = [
    { id: 'studio', label: 'Studio', draw: function (ctx) {
      var g = ctx.createRadialGradient(W / 2, H * 0.4, 60, W / 2, H / 2, W * 0.75);
      g.addColorStop(0, '#f4f5f7'); g.addColorStop(1, '#9aa3ad');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    } },
    { id: 'wall', label: 'Warm wall', draw: function (ctx) {
      ctx.fillStyle = grad(ctx, [[0, '#efe6da'], [1, '#e2d4c1']]); ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#c9a77f'; ctx.fillRect(0, H * 0.78, W, H * 0.22);
      ctx.fillStyle = '#b8936a'; ctx.fillRect(0, H * 0.78, W, 8);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(W * 0.08, H * 0.52, W * 0.26, 10); // shelf
      ctx.fillStyle = '#d97757'; ctx.fillRect(W * 0.11, H * 0.44, 46, 54); // pot
      ctx.fillStyle = '#5b8c5a';
      [[0.12, 0.36, 40], [0.16, 0.32, 46], [0.2, 0.37, 34]].forEach(function (l) { ctx.beginPath(); ctx.ellipse(W * l[0], H * l[1], l[2], l[2] * 0.55, -0.6, 0, Math.PI * 2); ctx.fill(); });
      ctx.fillStyle = '#7a5c3e'; ctx.fillRect(W * 0.25, H * 0.42, 70, 52);
    } },
    { id: 'navy', label: 'Haptags navy', draw: function (ctx) {
      var g = ctx.createRadialGradient(W * 0.75, H * 0.2, 40, W * 0.6, H * 0.5, W);
      g.addColorStop(0, '#1f6fd6'); g.addColorStop(0.45, '#0a2c4d'); g.addColorStop(1, '#02162b');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 2;
      for (var i = -H; i < W; i += 60) { ctx.beginPath(); ctx.moveTo(i, H); ctx.lineTo(i + H, 0); ctx.stroke(); }
    } },
    { id: 'books', label: 'Bookshelf', draw: function (ctx) {
      ctx.fillStyle = '#6b4b32'; ctx.fillRect(0, 0, W, H);
      var colors = ['#c0392b', '#2e5c8a', '#d4a24c', '#3d7a5a', '#8e5a9a', '#e0d6c3', '#1f3b57', '#b5651d'];
      var seed = 7; var rnd = function () { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
      for (var row = 0; row < 4; row += 1) {
        var y = 30 + row * 175; var x = 20;
        ctx.fillStyle = '#4a3322'; ctx.fillRect(0, y + 150, W, 18);
        while (x < W - 30) {
          var bw = 22 + rnd() * 26; var bh = 105 + rnd() * 45;
          ctx.fillStyle = colors[Math.floor(rnd() * colors.length)];
          ctx.fillRect(x, y + 150 - bh, bw - 3, bh);
          x += bw + (rnd() < 0.08 ? 40 : 0);
        }
      }
    } },
    { id: 'window', label: 'Office window', draw: function (ctx) {
      ctx.fillStyle = grad(ctx, [[0, '#cfe3f5'], [1, '#eef3f7']]); ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(120,150,175,.35)';
      [[0.05, 0.42, 0.12, 0.58], [0.2, 0.3, 0.1, 0.7], [0.33, 0.5, 0.14, 0.5], [0.6, 0.36, 0.11, 0.64], [0.78, 0.46, 0.16, 0.54]].forEach(function (b) { ctx.fillRect(W * b[0], H * b[1], W * b[2], H * b[3]); });
      ctx.fillStyle = '#f7f7f5';
      for (var x = 0; x <= W; x += W / 4) ctx.fillRect(x - 9, 0, 18, H);
      ctx.fillRect(0, H * 0.48, W, 16);
    } },
    { id: 'sunset', label: 'Sunset', draw: function (ctx) {
      ctx.fillStyle = grad(ctx, [[0, '#2d1b4e'], [0.45, '#c2456b'], [0.75, '#f39c5b'], [1, '#fbd48b']]); ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,236,190,.9)'; ctx.beginPath(); ctx.arc(W * 0.7, H * 0.72, 90, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2a1838'; ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(0, H * 0.8); ctx.quadraticCurveTo(W * 0.3, H * 0.68, W * 0.55, H * 0.82); ctx.quadraticCurveTo(W * 0.8, H * 0.9, W, H * 0.78); ctx.lineTo(W, H); ctx.fill();
    } },
  ];
  var presetCache = {};
  function presetCanvas(id) {
    if (!presetCache[id]) {
      var p = PRESETS.filter(function (x) { return x.id === id; })[0];
      presetCache[id] = p ? paint(p.draw) : null;
    }
    return presetCache[id];
  }
  function thumb(id) {
    var src = presetCanvas(id);
    var c = document.createElement('canvas'); c.width = 192; c.height = 108;
    c.getContext('2d').drawImage(src, 0, 0, 192, 108);
    return c.toDataURL('image/jpeg', 0.8);
  }

  function drawCover(ctx, img, w, h) {
    var iw = img.naturalWidth || img.width; var ih = img.naturalHeight || img.height;
    var s = Math.max(w / iw, h / ih);
    ctx.drawImage(img, (w - iw * s) / 2, (h - ih * s) / 2, iw * s, ih * s);
  }

  /**
   * Wraps a camera track. effect: { type: 'blur-light' | 'blur' | 'image', image?: CanvasImageSource }.
   * Returns { track, setEffect(effect), stop() }; `track` is what gets sent and previewed.
   */
  function Pipeline(rawTrack, effect) {
    var settings = rawTrack.getSettings ? rawTrack.getSettings() : {};
    var aspect = settings.width && settings.height ? settings.width / settings.height : 16 / 9;
    var w = 640; var h = Math.round(w / aspect);
    var video = document.createElement('video');
    video.muted = true; video.playsInline = true;
    video.srcObject = new MediaStream([rawTrack]);
    video.play().catch(function () {});

    var out = document.createElement('canvas'); out.width = w; out.height = h;
    var ctx = out.getContext('2d');
    var person = document.createElement('canvas'); person.width = w; person.height = h;
    var pctx = person.getContext('2d');
    var mask = document.createElement('canvas');
    var mctx = mask.getContext('2d');
    var maskData = null;
    var current = effect;
    var lastTs = 0;

    function compose(confidence) {
      var mw = confidence.width; var mh = confidence.height;
      var vals = confidence.getAsFloat32Array();
      if (mask.width !== mw || mask.height !== mh) { mask.width = mw; mask.height = mh; maskData = mctx.createImageData(mw, mh); }
      var d = maskData.data;
      for (var i = 0, j = 3; i < vals.length; i += 1, j += 4) {
        var v = (vals[i] - 0.25) / 0.5; // sharpen the edge a little
        d[j] = v <= 0 ? 0 : v >= 1 ? 255 : v * 255;
      }
      mctx.putImageData(maskData, 0, 0);

      pctx.globalCompositeOperation = 'copy';
      pctx.filter = 'none';
      pctx.drawImage(video, 0, 0, w, h);
      pctx.globalCompositeOperation = 'destination-in';
      pctx.filter = 'blur(2px)';
      pctx.drawImage(mask, 0, 0, w, h);
      pctx.filter = 'none';

      ctx.globalCompositeOperation = 'copy';
      if (current.type === 'image' && current.image) {
        ctx.filter = 'none';
        drawCover(ctx, current.image, w, h);
      } else {
        ctx.filter = current.type === 'blur-light' ? 'blur(6px)' : 'blur(16px)';
        ctx.drawImage(video, -20, -20, w + 40, h + 40); // overdraw so the blur doesn't darken the edges
        ctx.filter = 'none';
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(person, 0, 0);
    }

    function frame() {
      if (video.readyState < 2) return;
      if (!segmenter) { ctx.drawImage(video, 0, 0, w, h); return; }
      var ts = performance.now();
      if (ts <= lastTs) ts = lastTs + 1;
      lastTs = ts;
      try {
        segmenter.segmentForVideo(video, ts, function (result) {
          if (result.confidenceMasks && result.confidenceMasks[0]) compose(result.confidenceMasks[0]);
        });
      } catch (e) { ctx.drawImage(video, 0, 0, w, h); }
    }

    var ticker = new Worker('/static/js/meet-ticker.js');
    ticker.onmessage = frame;
    ticker.postMessage({ fps: FPS });
    var stream = out.captureStream(FPS);
    var track = stream.getVideoTracks()[0];

    return {
      track: track,
      setEffect: function (e) { current = e; },
      stop: function () {
        ticker.postMessage({ fps: 0 }); ticker.terminate();
        track.stop();
        video.srcObject = null;
      },
    };
  }

  window.MeetFX = {
    supported: supported,
    load: load,
    presets: PRESETS.map(function (p) { return { id: p.id, label: p.label }; }),
    thumb: thumb,
    presetImage: presetCanvas,
    Pipeline: Pipeline,
  };
})();
