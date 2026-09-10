(() => {
  "use strict";

  const PRESETS = {
    clean: 0.28,
    classic: 0.58,
    deep: 0.86
  };

  const video = document.getElementById("video");
  const canvas = document.getElementById("view");
  const strength = document.getElementById("strength");
  const strengthLabel = document.getElementById("strengthLabel");
  const recBtn = document.getElementById("recBtn");
  const recPill = document.getElementById("recPill");
  const timerEl = document.getElementById("timer");
  const flipBtn = document.getElementById("flipBtn");
  const muteBtn = document.getElementById("muteBtn");
  const shotBtn = document.getElementById("shotBtn");
  const toast = document.getElementById("toast");
  const sheet = document.getElementById("sheet");
  const replay = document.getElementById("replay");
  const shareBtn = document.getElementById("shareBtn");
  const dlBtn = document.getElementById("dlBtn");
  const closeBtn = document.getElementById("closeBtn");
  const installBtn = document.getElementById("installBtn");
  const gate = document.getElementById("gate");
  const startBtn = document.getElementById("startBtn");
  const ovalBtn = document.getElementById("ovalBtn");
  const jamBtn = document.getElementById("jamBtn");
  const stampBtn = document.getElementById("stampBtn");
  const bed = document.getElementById("bed");

  let gl = null;
  let program = null;
  let tex = null;
  let uStrength = null;
  let uResolution = null;
  let facingMode = "environment";
  let stream = null;
  let audioTrack = null;
  let micOn = true;
  let recorder = null;
  let chunks = [];
  let recUrl = null;
  let recBlob = null;
  let recTimer = 0;
  let recStarted = 0;
  let raf = 0;
  let deferredPrompt = null;
  let ovalOn = false;
  let uOval = null;
  let jamOn = true;
  let stampOn = false;
  let audioCtx = null;
  let bedBuffer = null;
  let bedSource = null;
  let speakerGain = null;
  let stampGain = null;
  let mixDest = null;
  let micNode = null;

  const VERT = `
    attribute vec2 aPos;
    attribute vec2 aUv;
    varying vec2 vUv;
    void main() {
      vUv = aUv;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  const FRAG = `
    precision mediump float;
    varying vec2 vUv;
    uniform sampler2D uTex;
    uniform float uStrength;
    uniform vec2 uResolution;
    uniform float uOval;
    void main() {
      vec2 uv = vUv;
      vec2 c = uv * 2.0 - 1.0;
      float aspect = uResolution.x / max(uResolution.y, 1.0);
      c.x *= aspect;
      float r = length(c);
      float k = uStrength * 1.35;
      float barrel = 1.0 + k * r * r;
      vec2 d = c / barrel;
      d.x /= aspect;
      vec2 sampleUv = d * 0.5 + 0.5;
      vec4 col = vec4(0.0, 0.0, 0.0, 1.0);
      if (sampleUv.x >= 0.0 && sampleUv.x <= 1.0 && sampleUv.y >= 0.0 && sampleUv.y <= 1.0) {
        col = texture2D(uTex, sampleUv);
      }
      if (uOval > 0.5) {
        vec2 p = uv * 2.0 - 1.0;
        p.x *= aspect;
        float margin = 0.90;
        float radius = min(aspect, 1.0) * margin;
        float er = length(p) / max(radius, 0.001);
        float mask = 1.0 - smoothstep(0.96, 1.04, er);
        col.rgb *= mask;
      }
      gl_FragColor = col;
    }
  `;

  function ping(msg) {
    toast.textContent = msg;
    toast.style.display = "block";
    setTimeout(() => { toast.style.display = "none"; }, 1800);
  }

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || "shader compile failed");
    }
    return sh;
  }

  function initGL() {
    gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, alpha: false });
    if (!gl) throw new Error("webgl missing");
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "program link failed");
    }
    gl.useProgram(program);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 1,
       1, -1, 1, 1,
      -1,  1, 0, 0,
       1,  1, 1, 0
    ]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "aPos");
    const aUv = gl.getAttribLocation(program, "aUv");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    uStrength = gl.getUniformLocation(program, "uStrength");
    uResolution = gl.getUniformLocation(program, "uResolution");
    uOval = gl.getUniformLocation(program, "uOval");
  }

  function sizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(window.innerWidth * dpr));
    const h = Math.max(1, Math.floor(window.innerHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function draw() {
    raf = requestAnimationFrame(draw);
    if (!gl || video.readyState < 2) return;
    sizeCanvas();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
    } catch (err) {
      return;
    }
    gl.uniform1f(uStrength, Number(strength.value) / 100);
    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.uniform1f(uOval, ovalOn ? 1.0 : 0.0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function stopStream() {
    if (!stream) return;
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
    audioTrack = null;
  }

  function withTimeout(promise, ms, label) {
    let timer = 0;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label || "timed out — tap try again")), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async function getStream(mode) {
    // One prompt when possible (smoother). No Permissions API (hangs on iPhone).
    // Fall back to video-only, then attach mic separately if needed.
    const videoIdeal = { facingMode: { ideal: mode } };
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: videoIdeal,
        audio: !!micOn
      });
    } catch (err) {
      /* continue */
    }
    let videoStream;
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: videoIdeal,
        audio: false
      });
    } catch (err) {
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false
      });
    }
    if (micOn) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false
        });
        mic.getAudioTracks().forEach((t) => videoStream.addTrack(t));
      } catch (err) {
        try { ping("camera ok — mic off"); } catch (e) {}
      }
    }
    return videoStream;
  }

  async function openCam() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("camera api missing — use safari/chrome on https");
    }
    stopStream();
    stream = await getStream(facingMode);
    audioTrack = stream.getAudioTracks()[0] || null;
    if (audioTrack) audioTrack.enabled = micOn;

    video.setAttribute("playsinline", "true");
    video.setAttribute("webkit-playsinline", "true");
    video.setAttribute("autoplay", "true");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;

    // Only timeout post-stream wiring — never the permission prompt itself
    await withTimeout(new Promise((resolve) => {
      if (video.readyState >= 1) resolve();
      else {
        const done = () => resolve();
        video.onloadedmetadata = done;
        video.onloadeddata = done;
      }
    }), 8000, "preview stalled — tap try again");

    try {
      await video.play();
    } catch (err) {
      await new Promise((r) => setTimeout(r, 50));
      await video.play();
    }
    muteBtn.textContent = micOn ? "mic" : "mute";
  }

  function pickMime() {
    const types = [
      "video/mp4",
      "video/mp4;codecs=avc1,mp4a.40.2",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm"
    ];
    if (!window.MediaRecorder) return "";
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  }

  function extFor(blob) {
    const type = (blob && blob.type) || "";
    if (type.includes("mp4")) return "mp4";
    if (type.includes("png")) return "png";
    if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
    return "webm";
  }

  async function saveToPhotos(blob, basename) {
    if (!blob) return;
    const name = basename + "." + extFor(blob);
    const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "clipfish" });
        ping("pick save video / save image");
        return;
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    ping("saved — check downloads / photos");
  }

  function fmt(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }

  function startTimer() {
    recStarted = Date.now();
    recTimer = setInterval(() => {
      timerEl.textContent = fmt(Date.now() - recStarted);
    }, 250);
  }

  function stopTimer() {
    clearInterval(recTimer);
    timerEl.textContent = "00:00";
  }

  async function hookBedGraph() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    if (!speakerGain) {
      speakerGain = audioCtx.createGain();
      speakerGain.gain.value = jamOn ? 0.8 : 0;
      speakerGain.connect(audioCtx.destination);
    }
    if (!stampGain) {
      stampGain = audioCtx.createGain();
      stampGain.gain.value = 0.7;
    }
    if (!bedSource) {
      try {
        bedSource = audioCtx.createMediaElementSource(bed);
        bedSource.connect(speakerGain);
        bedSource.connect(stampGain);
      } catch (err) {
        bedSource = true;
      }
    }
  }

  async function ensureBed() {
    if (!bed) throw new Error("track element missing");
    bed.loop = true;
    bed.playsInline = true;
    bed.setAttribute("playsinline", "true");
    bed.muted = false;
    bed.volume = jamOn ? 0.85 : 0;
    // Make sure the mp3 is actually ready (not a HTML 404 fallback)
    if (!bed.src && bed.querySelector("source")) {
      /* browser picks source */
    }
    if (bed.readyState < 2) {
      try { bed.load(); } catch (e) {}
      await withTimeout(new Promise((resolve, reject) => {
        const ok = () => resolve();
        const bad = () => reject(new Error("skate track failed to load"));
        bed.addEventListener("canplay", ok, { once: true });
        bed.addEventListener("error", bad, { once: true });
      }), 20000, "skate track still loading — tap jam on");
    }
    // Wire Web Audio BEFORE play so iOS routes through the graph correctly
    try { await hookBedGraph(); } catch (err) {}
    try {
      await bed.play();
    } catch (err) {
      await new Promise((r) => setTimeout(r, 40));
      await bed.play();
    }
    if (speakerGain) speakerGain.gain.value = jamOn ? 0.8 : 0;
  }

  function setJam(on) {
    jamOn = on;
    jamBtn.classList.toggle("active", jamOn);
    jamBtn.setAttribute("aria-pressed", jamOn ? "true" : "false");
    jamBtn.textContent = jamOn ? "jam on" : "jam off";
    bed.volume = jamOn ? 0.85 : 0;
    bed.muted = !jamOn;
    if (speakerGain) speakerGain.gain.value = jamOn ? 0.8 : 0;
    if (jamOn) bed.play().catch(() => {});
    else bed.pause();
  }

  function setStamp(on) {
    stampOn = on;
    stampBtn.classList.toggle("active", stampOn);
    stampBtn.setAttribute("aria-pressed", stampOn ? "true" : "false");
    stampBtn.textContent = stampOn ? "stamp on" : "stamp off";
  }

  jamBtn.addEventListener("click", async () => {
    try { await ensureBed(); } catch (err) { ping("track blocked"); }
    setJam(!jamOn);
    ping(jamOn ? "skate and destroy looping" : "jam muted");
  });

  stampBtn.addEventListener("click", () => {
    setStamp(!stampOn);
    ping(stampOn ? "track stamps the clip" : "clip stays dry");
  });

  function startRec() {
    if (!stream) {
      ping("open camera first");
      return;
    }
    if (!window.MediaRecorder) {
      ping("recording not supported on this browser");
      return;
    }
    chunks = [];
    let recordStream;
    try {
      const canvasStream = canvas.captureStream(30);
      recordStream = new MediaStream(canvasStream.getVideoTracks());
    } catch (err) {
      recordStream = new MediaStream(stream.getVideoTracks());
    }
    try {
      if (stampOn && audioCtx && stampGain) {
        mixDest = audioCtx.createMediaStreamDestination();
        stampGain.connect(mixDest);
        if (micOn && audioTrack) {
          if (micNode) try { micNode.disconnect(); } catch (e) {}
          micNode = audioCtx.createMediaStreamSource(new MediaStream([audioTrack]));
          micNode.connect(mixDest);
        }
        mixDest.stream.getAudioTracks().forEach((t) => recordStream.addTrack(t));
      } else if (micOn && audioTrack) {
        recordStream.addTrack(audioTrack);
      }
    } catch (err) {
      if (micOn && audioTrack) recordStream.addTrack(audioTrack);
    }
    const mime = pickMime();
    recorder = mime ? new MediaRecorder(recordStream, { mimeType: mime }) : new MediaRecorder(recordStream);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      recBlob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
      if (recUrl) URL.revokeObjectURL(recUrl);
      recUrl = URL.createObjectURL(recBlob);
      replay.src = recUrl;
      sheet.classList.add("open");
    };
    recorder.start(200);
    recBtn.classList.add("live");
    recPill.classList.add("on");
    startTimer();
    ping("recording");
  }

  function stopRec() {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recBtn.classList.remove("live");
    recPill.classList.remove("on");
    stopTimer();
    if (stampGain && mixDest) {
      try { stampGain.disconnect(mixDest); } catch (err) {}
    }
    if (micNode) {
      try { micNode.disconnect(); } catch (err) {}
      micNode = null;
    }
    mixDest = null;
  }

  function setPreset(name) {
    const value = PRESETS[name];
    strength.value = String(Math.round(value * 100));
    strengthLabel.textContent = value.toFixed(2);
    document.querySelectorAll(".chip[data-lens]").forEach((el) => {
      el.classList.toggle("active", el.dataset.lens === name);
    });
  }

  document.querySelectorAll(".chip[data-lens]").forEach((el) => {
    el.addEventListener("click", () => setPreset(el.dataset.lens));
  });

  function setOval(on) {
    ovalOn = on;
    ovalBtn.classList.toggle("active", ovalOn);
    ovalBtn.setAttribute("aria-pressed", ovalOn ? "true" : "false");
    ovalBtn.textContent = ovalOn ? "circle on" : "circle off";
    try { localStorage.setItem("clipfish-oval", ovalOn ? "1" : "0"); } catch (err) {}
  }

  ovalBtn.addEventListener("click", () => setOval(!ovalOn));
  try { if (localStorage.getItem("clipfish-oval") === "1") setOval(true); } catch (err) {}

  strength.addEventListener("input", () => {
    strengthLabel.textContent = (Number(strength.value) / 100).toFixed(2);
    document.querySelectorAll(".chip[data-lens]").forEach((el) => el.classList.remove("active"));
  });

  recBtn.addEventListener("click", () => {
    if (recorder && recorder.state === "recording") stopRec();
    else startRec();
  });

  flipBtn.addEventListener("click", async () => {
    facingMode = facingMode === "environment" ? "user" : "environment";
    try { await openCam(); } catch (err) { ping("camera blocked"); }
  });

  muteBtn.addEventListener("click", () => {
    micOn = !micOn;
    if (audioTrack) audioTrack.enabled = micOn;
    muteBtn.textContent = micOn ? "mic" : "mute";
    ping(micOn ? "mic on" : "mic off");
  });

  shotBtn.addEventListener("click", () => {
    canvas.toBlob((blob) => {
      if (!blob) return;
      saveToPhotos(blob, "clipfish-still");
    }, "image/jpeg", 0.92);
  });

  closeBtn.addEventListener("click", () => sheet.classList.remove("open"));

  dlBtn.addEventListener("click", () => saveToPhotos(recBlob, "clipfish-clip"));

  shareBtn.addEventListener("click", () => saveToPhotos(recBlob, "clipfish-clip"));

  window.addEventListener("resize", sizeCanvas);

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.classList.add("show");
  });

  installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.classList.remove("show");
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  async function bootCam() {
    if (startBtn.disabled) return;
    startBtn.disabled = true;
    const prev = startBtn.textContent || "open lens";
    startBtn.textContent = "opening…";
    ping("allow camera / mic if asked");
    try {
      if (!gl) initGL();
      await openCam();
      if (jamOn) {
        try {
          await ensureBed();
          ping("skate and destroy");
        } catch (err) {
          ping(err && err.message ? err.message : "tap jam on for track");
        }
      }
      if (!raf) draw();
      gate.classList.add("hidden");
      startBtn.textContent = prev;
      ping("lens live");
    } catch (err) {
      stopStream();
      gate.classList.remove("hidden");
      startBtn.textContent = "try camera again";
      const msg = err && err.name === "NotAllowedError"
        ? "permission denied — Settings → Camera for this site"
        : (err && err.message ? err.message : "camera blocked");
      ping(msg);
    } finally {
      startBtn.disabled = false;
    }
  }

  startBtn.addEventListener("click", () => {
    bootCam();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && stream && video.paused) {
      video.play().catch(() => {});
    }
  });

  try { initGL(); } catch (err) { ping("webgl missing"); }
  try { if (bed) bed.load(); } catch (err) {}
})();
