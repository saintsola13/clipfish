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
      if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      gl_FragColor = texture2D(uTex, sampleUv);
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
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
    gl.uniform1f(uStrength, Number(strength.value) / 100);
    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  async function openCam() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    const constraints = {
      audio: { echoCancellation: true, noiseSuppression: true },
      video: {
        facingMode,
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    audioTrack = stream.getAudioTracks()[0] || null;
    if (audioTrack) audioTrack.enabled = micOn;
    video.srcObject = stream;
    await video.play();
    muteBtn.textContent = micOn ? "mic" : "mute";
  }

  function pickMime() {
    const types = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4"
    ];
    return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
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

  function startRec() {
    if (!stream) return;
    chunks = [];
    const canvasStream = canvas.captureStream(30);
    const mixed = new MediaStream(canvasStream.getVideoTracks());
    if (micOn && audioTrack) mixed.addTrack(audioTrack);
    const mime = pickMime();
    recorder = mime ? new MediaRecorder(mixed, { mimeType: mime }) : new MediaRecorder(mixed);
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
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "clipfish-still.png";
      a.click();
    }, "image/png");
  });

  closeBtn.addEventListener("click", () => sheet.classList.remove("open"));

  dlBtn.addEventListener("click", () => {
    if (!recUrl) return;
    const a = document.createElement("a");
    a.href = recUrl;
    a.download = "clipfish-clip.webm";
    a.click();
  });

  shareBtn.addEventListener("click", async () => {
    if (!recBlob) return;
    const file = new File([recBlob], "clipfish-clip.webm", { type: recBlob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "clipfish" });
    } else {
      ping("share not supported — download instead");
    }
  });

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

  (async () => {
    try {
      initGL();
      await openCam();
      draw();
    } catch (err) {
      ping("allow camera + mic");
    }
  })();
})();
