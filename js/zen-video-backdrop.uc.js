// ==UserScript==
// @name           zen-video-backdrop.uc.js
// @description    Plays looping videos from a local folder behind the entire Zen UI.
// @author         Vibee0
// @version        0.1.0
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

  // -------- DOM injection ----------------------------------------------

  function createBackdrop(doc) {
    const root = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    root.id = "zen-video-backdrop";

    const v1 = doc.createElementNS("http://www.w3.org/1999/xhtml", "video");
    const v2 = doc.createElementNS("http://www.w3.org/1999/xhtml", "video");
    for (const v of [v1, v2]) {
      v.autoplay = true;
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.preload = "auto";
      v.setAttribute("disablepictureinpicture", "true");
    }
    v1.classList.add("zvb-active");
    v2.classList.add("zvb-hiding");

    const dim = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    dim.className = "zvb-dim";

    root.appendChild(v1);
    root.appendChild(v2);
    root.appendChild(dim);

    return { root, v1, v2, dim };
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
    activeVideoEl: null,
    inactiveVideoEl: null,
    rootEl: null,
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

        const { root, v1, v2, dim } = createBackdrop(document);
        this.rootEl = root;
        this.activeVideoEl = v1;
        this.inactiveVideoEl = v2;
        this.dimEl = dim;
        this.mainWindow.insertBefore(root, this.mainWindow.firstChild);

        applyCssVars(this.mainWindow, this.cfg);
        this.applyVideoElProps(this.activeVideoEl);
        this.applyVideoElProps(this.inactiveVideoEl);

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

    applyVideoElProps(v) {
      v.muted = this.cfg.mute;
      v.playbackRate = this.cfg.playbackRatePct / 100;
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
      if (this.current && this.current.url === file.url) {
        // restart muted on same file — keep playing
        return;
      }
      this.current = file;
      log("→", file.name);

      if (!fade || this.cfg.fadeMs === 0) {
        this.activeVideoEl.src = file.url;
        try { this.activeVideoEl.play(); } catch (_) {}
        this.inactiveVideoEl.classList.add("zvb-hiding");
        this.inactiveVideoEl.classList.remove("zvb-active");
      } else {
        const incoming = this.inactiveVideoEl;
        const outgoing = this.activeVideoEl;

        incoming.src = file.url;
        incoming.classList.add("zvb-hiding");
        try { incoming.play(); } catch (_) {}

        // next frame: swap classes to fade
        window.requestAnimationFrame(() => {
          incoming.classList.remove("zvb-hiding");
          incoming.classList.add("zvb-active");
          outgoing.classList.add("zvb-hiding");
          outgoing.classList.remove("zvb-active");
        });

        // after fade: pause outgoing
        setTimeout(() => {
          try { outgoing.pause(); } catch (_) {}
          outgoing.removeAttribute("src");
          try { outgoing.load(); } catch (_) {}
        }, this.cfg.fadeMs + 100);

        this.activeVideoEl = incoming;
        this.inactiveVideoEl = outgoing;
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
        this.applyVideoElProps(this.activeVideoEl);
        this.applyVideoElProps(this.inactiveVideoEl);

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
