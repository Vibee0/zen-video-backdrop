// ==UserScript==
// @name           zen-video-backdrop.uc.js
// @description    Plays looping videos from a local folder behind the entire Zen UI.
// @author         Vibee0
// @version        0.2.0
// @include        main
// @grant          none
// ==/UserScript==

(function () {
  "use strict";

  if (window.ZenVideoBackdrop) {
    try { window.ZenVideoBackdrop.destroy(); } catch (_) {}
  }

  const PREF_PREFIX = "zen-video-backdrop.";
  const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov", ".m4v", ".ogv", ".ogg"];
  const LOG_PREFIX = "[zen-video-backdrop]";
  const XHTML_NS = "http://www.w3.org/1999/xhtml";

  const log  = (...a) => console.log(LOG_PREFIX, ...a);
  const warn = (...a) => console.warn(LOG_PREFIX, ...a);
  const err  = (...a) => console.error(LOG_PREFIX, ...a);

  // -------- Pref helpers ------------------------------------------------

  function prefName(key) { return PREF_PREFIX + key; }

  function getString(key, fallback) {
    try { return Services.prefs.getStringPref(prefName(key), fallback); }
    catch (_) { return fallback; }
  }

  function getInt(key, fallback) {
    try {
      const type = Services.prefs.getPrefType(prefName(key));
      if (type === Services.prefs.PREF_INT) {
        return Services.prefs.getIntPref(prefName(key));
      }
      if (type === Services.prefs.PREF_STRING) {
        const str = Services.prefs.getStringPref(prefName(key), "");
        const n = parseFloat(str);
        return Number.isFinite(n) ? n : fallback;
      }
    } catch (_) {}
    return fallback;
  }

  function getBool(key, fallback) {
    try { return Services.prefs.getBoolPref(prefName(key), fallback); }
    catch (_) { return fallback; }
  }

  function setString(key, value) {
    try { Services.prefs.setStringPref(prefName(key), value); } catch (e) { warn("setString", key, e); }
  }

  // -------- Config snapshot ---------------------------------------------

  function readConfig() {
    return {
      videosDir:        getString("videos-dir", "D:\\Users\\user\\Videos\\zen"),
      randomize:        getBool("randomize", true),
      frequency:        getString("frequency", "tabs"),
      periodMinutes:    Math.max(1, getInt("period-minutes", 15)),
      fit:              getString("fit", "cover"),
      zoomPercent:      Math.max(10, getInt("zoom-percent", 100)),
      brightnessPct:    Math.max(0, Math.min(200, getInt("brightness-percent", 100))),
      blurPx:           Math.max(0, getInt("blur-px", 0)),
      dimPct:           Math.max(0, Math.min(100, getInt("dim-percent", 0))),
      fadeMs:           Math.max(0, getInt("fade-ms", 600)),
      playbackRatePct:  Math.max(25, Math.min(400, getInt("playback-rate-percent", 100))),
      mute:             getBool("mute", true),
      transparent:      getBool("transparent-newtab", true),
    };
  }

  // -------- Filesystem --------------------------------------------------

  function listVideoFiles(dirPath) {
    const dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    try { dir.initWithPath(dirPath); }
    catch (e) { warn("invalid path", dirPath, e); return []; }

    if (!dir.exists() || !dir.isDirectory()) {
      warn("dir missing or not a directory:", dirPath);
      return [];
    }

    const results = [];
    const enumerator = dir.directoryEntries;
    while (enumerator.hasMoreElements()) {
      let entry;
      try { entry = enumerator.getNext().QueryInterface(Ci.nsIFile); }
      catch (_) { continue; }
      if (!entry.isFile()) continue;
      const name = entry.leafName.toLowerCase();
      if (!VIDEO_EXTENSIONS.some(ext => name.endsWith(ext))) continue;
      results.push({
        name: entry.leafName,
        path: entry.path,
        url:  Services.io.newFileURI(entry).spec,
      });
    }
    results.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return results;
  }

  // -------- Frequency logic --------------------------------------------

  function needsChange(frequency, lastIso, periodMinutes) {
    const now = new Date();
    const last = lastIso ? new Date(lastIso) : null;

    if (!last || isNaN(last.getTime())) return true;

    switch (frequency) {
      case "pause":  return false;
      case "tabs":   return true; // controlled by tab listener
      case "hour":   return now.getDate() !== last.getDate() || now.getHours() !== last.getHours();
      case "day":    return now.getDate() !== last.getDate() || now.getMonth() !== last.getMonth() || now.getFullYear() !== last.getFullYear();
      case "period": return (now - last) >= periodMinutes * 60_000;
      default:       return false;
    }
  }

  function pickNext(files, currentUrl, randomize) {
    if (files.length === 0) return null;
    if (files.length === 1) return files[0];

    if (randomize) {
      let candidate;
      let tries = 8;
      do {
        candidate = files[Math.floor(Math.random() * files.length)];
        tries--;
      } while (candidate.url === currentUrl && tries > 0);
      return candidate;
    }

    const idx = files.findIndex(f => f.url === currentUrl);
    return files[(idx + 1) % files.length];
  }

  // -------- VideoLooper -------------------------------------------------
  //
  // Mirrors Bonjourr's `src/scripts/features/backgrounds/VideoLooper.ts`.
  //
  // Two <video> elements share the SAME src. As one approaches the end
  // (within `fadeMs`), the other starts playing from t=0 and the first
  // fades out. When the first ends, it rewinds and goes to the back of
  // the DOM (so it's behind the now-playing one). This produces a
  // seamless loop without the visible cut you get from `video.loop=true`.
  //
  // If `fadeMs === 0` we skip all of that and just use the native
  // HTMLVideoElement `loop` attribute on a single video (Bonjourr does
  // the same).

  class VideoLooper {
    constructor(doc, src, fadeMs, playbackRate, muted) {
      this.doc = doc;
      this.win = doc.defaultView;
      this.src = src;
      this.fadeMs = Math.max(0, fadeMs);
      this.playbackRate = playbackRate;
      this.muted = muted;
      this.destroyed = false;

      this.container = doc.createElementNS(XHTML_NS, "div");
      this.container.classList.add("zvb-loop");

      this.video1 = this._createVideo();
      this.video2 = this._createVideo();
      this.video1.classList.add("zvb-loop-v1");
      this.video2.classList.add("zvb-loop-v2");

      this.container.appendChild(this.video1);
      this.container.appendChild(this.video2);

      this._onV1TimeUpdate = () => this._onTimeUpdate(this.video1, this.video2);
      this._onV2TimeUpdate = () => this._onTimeUpdate(this.video2, this.video1);
      this._onVisibility   = () => this._onVisibilityChange();
      this._onFocus        = () => this._onVisibilityChange();
      this._onPause1       = () => this._maybeResumeAfterPause(this.video1);
      this._onPause2       = () => this._maybeResumeAfterPause(this.video2);
    }

    _createVideo() {
      const v = this.doc.createElementNS(XHTML_NS, "video");
      v.src = this.src;
      v.muted = this.muted;
      v.playsInline = true;
      v.autoplay = false;
      v.preload = "auto";
      v.playbackRate = this.playbackRate;
      v.setAttribute("disablepictureinpicture", "true");

      v.addEventListener("loadedmetadata", () => this._applyFadeTime());
      v.addEventListener("ratechange",     () => this._applyFadeTime());

      v.addEventListener("ended", () => {
        v.currentTime = 0;
        v.classList.remove("zvb-hiding");
        // Move ended video to the back of the DOM order so the still-playing
        // sibling renders on top during the fade.
        try { this.container.prepend(v); } catch (_) {}
      });

      return v;
    }

    start() {
      this.video1.addEventListener("timeupdate", this._onV1TimeUpdate);
      this.video2.addEventListener("timeupdate", this._onV2TimeUpdate);
      this.video1.addEventListener("pause", this._onPause1);
      this.video2.addEventListener("pause", this._onPause2);

      this.doc.addEventListener("visibilitychange", this._onVisibility);
      this.win.addEventListener("focus", this._onFocus);

      this._applyFadeTime();
      // Kick off playback. Mirrors Bonjourr's `loop()` which plays video2 first.
      this._play(this.video2);
    }

    _onTimeUpdate(current, other) {
      if (this.destroyed) return;
      if (this.fadeMs === 0) return;
      if (!this._isEnding(current)) return;
      if (other.classList.contains("zvb-hiding") === false && !other.paused) {
        // already crossfading
        return;
      }
      current.classList.add("zvb-hiding");
      other.classList.remove("zvb-hiding");
      this._play(other);
    }

    _isEnding(v) {
      if (!isFinite(v.duration) || v.duration === 0) return false;
      const ct  = (v.currentTime * 1000) / Math.max(0.01, this.playbackRate);
      const dur = (v.duration    * 1000) / Math.max(0.01, this.playbackRate);
      return ct > dur - this.fadeMs;
    }

    _applyFadeTime() {
      // Cap fade to half the (scaled) real duration so we never overshoot.
      const realDur = this._getRealDuration();
      const halfMs = Math.round((realDur / 2) * 1000);
      let fade = this.fadeMs;
      if (halfMs > 0 && halfMs < this.fadeMs) fade = halfMs;

      if (fade === 0) {
        this.video2.loop = true;
        this.video1.style.display = "none";
      } else {
        this.video2.loop = false;
        this.video1.style.display = "";
      }
      this.container.style.setProperty("--zvb-fade", `${fade}ms`);
    }

    _getRealDuration() {
      try {
        if (isFinite(this.video1.duration) && this.video1.duration > 0) {
          return this.video1.duration / Math.max(0.01, this.video1.playbackRate);
        }
      } catch (_) {}
      return 8;
    }

    _onVisibilityChange() {
      if (this.destroyed) return;
      if (!this.video2.isConnected) return;

      if (this.doc.hidden) {
        // Just pause; we'll resume the visible one when we come back.
        try { this.video1.pause(); } catch (_) {}
        try { this.video2.pause(); } catch (_) {}
      } else {
        // Pick whichever video is currently visible.
        const visible = this.video1.classList.contains("zvb-hiding") ? this.video2 : this.video1;
        this._play(visible);
      }
    }

    _maybeResumeAfterPause(v) {
      if (this.destroyed) return;
      if (this.doc.hidden) return;
      if (v.classList.contains("zvb-hiding")) return; // expected to be paused
      if (v.ended) return; // ended handler will restart it
      // Firefox sometimes pauses media when the window is occluded/restored;
      // resume the currently-visible video.
      this._play(v);
    }

    _play(v) {
      try {
        const p = v.play();
        if (p && typeof p.then === "function") {
          p.catch(e => warn("play() rejected", e?.name || e));
        }
      } catch (e) {
        warn("play() threw", e);
      }
    }

    setPlaybackRate(rate) {
      this.playbackRate = rate;
      this.video1.playbackRate = rate;
      this.video2.playbackRate = rate;
    }

    setMute(muted) {
      this.muted = muted;
      this.video1.muted = muted;
      this.video2.muted = muted;
    }

    setFadeMs(fadeMs) {
      this.fadeMs = Math.max(0, fadeMs);
      this._applyFadeTime();
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      try { this.video1.removeEventListener("timeupdate", this._onV1TimeUpdate); } catch (_) {}
      try { this.video2.removeEventListener("timeupdate", this._onV2TimeUpdate); } catch (_) {}
      try { this.video1.removeEventListener("pause", this._onPause1); } catch (_) {}
      try { this.video2.removeEventListener("pause", this._onPause2); } catch (_) {}
      try { this.doc.removeEventListener("visibilitychange", this._onVisibility); } catch (_) {}
      try { this.win.removeEventListener("focus", this._onFocus); } catch (_) {}
      try { this.video1.pause(); } catch (_) {}
      try { this.video2.pause(); } catch (_) {}
      try { this.video1.removeAttribute("src"); this.video1.load(); } catch (_) {}
      try { this.video2.removeAttribute("src"); this.video2.load(); } catch (_) {}
      try { this.container.remove(); } catch (_) {}
    }
  }

  // -------- DOM injection ----------------------------------------------

  function createBackdrop(doc) {
    const root = doc.createElementNS(XHTML_NS, "div");
    root.id = "zen-video-backdrop";

    const stage = doc.createElementNS(XHTML_NS, "div");
    stage.id = "zvb-stage";

    const dim = doc.createElementNS(XHTML_NS, "div");
    dim.className = "zvb-dim";

    root.appendChild(stage);
    root.appendChild(dim);

    return { root, stage, dim };
  }

  function applyCssVars(mainWindow, cfg) {
    const root = mainWindow.style;
    root.setProperty("--zvb-fit", cfg.fit);
    root.setProperty("--zvb-zoom", String(cfg.zoomPercent / 100));
    root.setProperty("--zvb-brightness", String(cfg.brightnessPct / 100));
    root.setProperty("--zvb-blur", `${cfg.blurPx}px`);
    root.setProperty("--zvb-fade", `${cfg.fadeMs}ms`);
    root.setProperty("--zvb-dim-alpha", String(cfg.dimPct / 100));

    if (cfg.transparent) {
      mainWindow.setAttribute("zvb-transparent-content", "true");
    } else {
      mainWindow.removeAttribute("zvb-transparent-content");
    }
  }

  // -------- Main controller --------------------------------------------

  const ZenVideoBackdrop = {
    cfg: null,
    files: [],
    current: null,           // {name, path, url}
    looper: null,            // VideoLooper instance for the current file
    rootEl: null,
    stageEl: null,
    dimEl: null,
    mainWindow: null,
    rotationTimer: null,
    rescanTimer: null,
    prefObserver: null,
    tabOpenListener: null,
    destroyed: false,

    init() {
      try {
        this.mainWindow = document.getElementById("main-window");
        if (!this.mainWindow) {
          warn("no #main-window — bailing");
          return;
        }

        this.cfg = readConfig();
        log("init, cfg =", this.cfg);

        const { root, stage, dim } = createBackdrop(document);
        this.rootEl = root;
        this.stageEl = stage;
        this.dimEl = dim;
        this.mainWindow.insertBefore(root, this.mainWindow.firstChild);

        applyCssVars(this.mainWindow, this.cfg);

        this.rescan();
        this.bootstrapCurrent();
        this.installPrefObserver();
        this.installTabListener();
        this.installRotationTimer();
        this.installRescanTimer();

        window.addEventListener("unload", () => this.destroy(), { once: true });
      } catch (e) {
        err("init failed", e);
      }
    },

    rescan() {
      this.files = listVideoFiles(this.cfg.videosDir);
      log(`rescan: found ${this.files.length} videos in ${this.cfg.videosDir}`);
    },

    bootstrapCurrent() {
      const savedUrl = getString("state.last-played-url", "");
      const savedAt  = getString("state.last-played-at",  "");
      let pick = this.files.find(f => f.url === savedUrl) || null;

      const dueForChange = needsChange(this.cfg.frequency, savedAt, this.cfg.periodMinutes);

      if (!pick || (dueForChange && this.cfg.frequency !== "tabs")) {
        pick = pickNext(this.files, savedUrl, this.cfg.randomize);
      }

      if (pick) {
        this.setCurrent(pick, /* fade */ false);
      } else {
        warn("no playable videos");
      }
    },

    setCurrent(file, fade = true) {
      if (!file) return;
      if (this.current && this.current.url === file.url && this.looper && !this.looper.destroyed) {
        // same file already playing — nothing to do
        return;
      }
      this.current = file;
      log("→", file.name);

      const newLooper = new VideoLooper(
        document,
        file.url,
        this.cfg.fadeMs,
        this.cfg.playbackRatePct / 100,
        this.cfg.mute,
      );

      // Insert new looper into the stage. CSS gives `.zvb-loop` a transition
      // on opacity, so adding it with the .zvb-entering class (opacity 0)
      // and then removing the class on the next frame produces a fade-in.
      newLooper.container.classList.add("zvb-entering");
      this.stageEl.appendChild(newLooper.container);
      newLooper.start();

      const oldLooper = this.looper;
      this.looper = newLooper;

      if (!fade || this.cfg.fadeMs === 0 || !oldLooper) {
        // No fade — just kill the old one.
        newLooper.container.classList.remove("zvb-entering");
        if (oldLooper) oldLooper.destroy();
      } else {
        // Crossfade between old and new looper containers.
        window.requestAnimationFrame(() => {
          newLooper.container.classList.remove("zvb-entering");
          oldLooper.container.classList.add("zvb-leaving");
        });
        setTimeout(() => {
          try { oldLooper.destroy(); } catch (_) {}
        }, this.cfg.fadeMs + 100);
      }

      setString("state.last-played-url", file.url);
      setString("state.last-played-at",  new Date().toISOString());
    },

    rotate(reason) {
      if (this.cfg.frequency === "pause") return;
      if (this.files.length === 0) return;
      const next = pickNext(this.files, this.current?.url ?? "", this.cfg.randomize);
      if (next) {
        log(`rotate(${reason})`);
        this.setCurrent(next, /* fade */ true);
      }
    },

    installPrefObserver() {
      this.prefObserver = (subject, topic, data) => {
        if (topic !== "nsPref:changed") return;
        if (!String(data || "").startsWith(PREF_PREFIX)) return;
        // ignore our own state writes to avoid feedback
        if (String(data).startsWith(PREF_PREFIX + "state.")) return;

        const oldCfg = this.cfg;
        this.cfg = readConfig();
        log("pref changed:", data, "→ new cfg");

        applyCssVars(this.mainWindow, this.cfg);

        if (this.looper) {
          this.looper.setPlaybackRate(this.cfg.playbackRatePct / 100);
          this.looper.setMute(this.cfg.mute);
          this.looper.setFadeMs(this.cfg.fadeMs);
        }

        if (oldCfg.videosDir !== this.cfg.videosDir) {
          this.rescan();
        }
        if (oldCfg.frequency !== this.cfg.frequency || oldCfg.periodMinutes !== this.cfg.periodMinutes) {
          this.installRotationTimer();
        }
      };
      Services.prefs.addObserver(PREF_PREFIX, this.prefObserver, false);
    },

    installTabListener() {
      const tabContainer = window.gBrowser?.tabContainer;
      if (!tabContainer) {
        warn("no gBrowser.tabContainer; tab-rotation disabled");
        return;
      }
      this.tabOpenListener = (_event) => {
        if (this.cfg.frequency === "tabs") {
          this.rotate("TabOpen");
        }
      };
      tabContainer.addEventListener("TabOpen", this.tabOpenListener, false);
    },

    installRotationTimer() {
      if (this.rotationTimer) {
        clearInterval(this.rotationTimer);
        this.rotationTimer = null;
      }
      if (this.cfg.frequency === "pause" || this.cfg.frequency === "tabs") return;

      let intervalMs;
      switch (this.cfg.frequency) {
        case "period": intervalMs = Math.max(60_000, this.cfg.periodMinutes * 60_000); break;
        case "hour":   intervalMs = 60_000; break;     // check every minute
        case "day":    intervalMs = 5 * 60_000; break; // check every 5 min
        default:       return;
      }

      this.rotationTimer = setInterval(() => {
        const last = getString("state.last-played-at", "");
        if (needsChange(this.cfg.frequency, last, this.cfg.periodMinutes)) {
          this.rotate(this.cfg.frequency);
        }
      }, intervalMs);
    },

    installRescanTimer() {
      // re-scan disk every 60s to pick up new files / removals
      this.rescanTimer = setInterval(() => {
        const before = this.files.length;
        this.rescan();
        if (this.files.length !== before) {
          log("file count changed, was", before, "now", this.files.length);
        }
      }, 60_000);
    },

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      try {
        if (this.prefObserver) Services.prefs.removeObserver(PREF_PREFIX, this.prefObserver);
      } catch (_) {}
      try {
        const tabContainer = window.gBrowser?.tabContainer;
        if (tabContainer && this.tabOpenListener) {
          tabContainer.removeEventListener("TabOpen", this.tabOpenListener, false);
        }
      } catch (_) {}
      if (this.rotationTimer) clearInterval(this.rotationTimer);
      if (this.rescanTimer)   clearInterval(this.rescanTimer);
      try { this.looper?.destroy(); } catch (_) {}
      try { this.rootEl?.remove(); } catch (_) {}
      try { this.mainWindow?.removeAttribute("zvb-transparent-content"); } catch (_) {}
      log("destroyed");
    },
  };

  window.ZenVideoBackdrop = ZenVideoBackdrop;

  if (document.readyState === "complete") {
    ZenVideoBackdrop.init();
  } else {
    window.addEventListener("DOMContentLoaded", () => ZenVideoBackdrop.init(), { once: true });
  }
})();
