(() => {
  if (globalThis.CaptionScreen) return;
  const distance = (first, second, box = [0, 0, 1000, 1000]) => {
    if (!first || !second) return 1;
    const left = Math.max(0, Math.floor(box[1] * 64 / 1000));
    const right = Math.min(64, Math.ceil(box[3] * 64 / 1000));
    const top = Math.max(0, Math.floor(box[0] * 36 / 1000));
    const bottom = Math.min(36, Math.ceil(box[2] * 36 / 1000));
    let difference = 0, count = 0;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const offset = (y * 64 + x) * 4;
      for (let c = 0; c < 3; c++) difference += Math.abs(first[offset + c] - second[offset + c]);
      count += 3;
    }
    return count ? difference / (count * 255) : 1;
  };
  const overlaps = (a, b) => a.x < b.x + b.width + 5 && a.x + a.width + 5 > b.x &&
    a.y < b.y + b.height + 5 && a.y + a.height + 5 > b.y;
  const changed = (first, second, urgent = false) => {
    if (distance(first, second) >= (urgent ? 0.18 : 0.012)) return true;
    let regions = 0, peak = 0;
    // Local changes catch new small text without reacting to codec noise everywhere.
    for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) {
      const delta = distance(first, second, [y * 250, x * 125, (y + 1) * 250, (x + 1) * 125]);
      if (delta >= 0.045) { regions++; peak = Math.max(peak, delta); }
    }
    return urgent ? regions > 0 && regions <= 4 && peak >= 0.06 : regions > 0;
  };
  const pairColors = ["#63d8f2", "#ffd166", "#ff8dae", "#a6e37c", "#c3a6ff", "#ffad78", "#75e1c0", "#a4c4ff", "#eea9e5", "#e1e878"];

  class ScreenText {
    constructor({ host, shadow, video, send, context }) {
      this.host = host;
      this.shadow = shadow;
      this.video = video;
      this.send = send;
      this.context = context;
      this.events = new AbortController();
      this.disposed = false;
      this.layer = shadow.querySelector(".screen-text");
      this.status = shadow.querySelector(".screen-state");
      this.enabled = false;
      this.interval = 3000;
      this.epoch = 0;
      this.items = [];
      this.nextAt = 0;
      this.retryAt = 0;
      this.emptyFrames = 0;
      this.toggle = shadow.querySelector(".screen-toggle");
      this.toggle?.addEventListener("click", async () => {
        this.toggle.disabled = true;
        try {
          const result = await this.send("SCREEN_TOGGLE", { enabled: !this.enabled });
          if (result?.error) throw new Error(result.error);
        } catch (error) { this.note(error.message); }
        finally { if (!this.disposed) this.toggle.disabled = false; }
      }, { signal: this.events.signal });
      this.canvas = document.createElement("canvas");
      this.sample = document.createElement("canvas");
      this.sample.width = 64;
      this.sample.height = 36;
      this.sampleContext = this.sample.getContext("2d", { willReadFrequently: true });
      this.context.call(() => chrome.storage.local.get({ screenTranslation: false, screenInterval: 3 }))
        .then(value => this.configure(value)).catch(error => { if (!this.disposed) this.note(error.message); });
      this.onStorageChange = (changes, area) => {
        if (area !== "local") return;
        if (changes.screenKeyRevision) this.retryAt = 0;
        if (changes.screenTranslation || changes.screenInterval || changes.screenKeyRevision) this.configure({
          screenTranslation: changes.screenTranslation?.newValue ?? this.enabled,
          screenInterval: changes.screenInterval?.newValue ?? this.interval / 1000,
        });
      };
      this.context.call(() => chrome.storage.onChanged.addListener(this.onStorageChange))
        .catch(error => { if (!this.disposed) this.note(error.message); });
      document.addEventListener("visibilitychange", () => {
        this.invalidate();
        if (!document.hidden) this.schedule(0);
      }, { signal: this.events.signal });
      for (const event of ["seeking", "emptied", "loadeddata"]) document.addEventListener(event, e => {
        if (e.target === this.video()) this.invalidate();
      }, { capture: true, signal: this.events.signal });
    }

    destroy() {
      if (this.disposed) return;
      this.disposed = true;
      this.active = false;
      clearTimeout(this.timer);
      this.timer = null;
      this.events.abort();
      if (this.toggle) this.toggle.disabled = true;
      this.host.style.visibility = "";
      try { chrome.storage.onChanged.removeListener(this.onStorageChange); } catch { /* Already invalid. */ }
      this.invalidate();
    }

    configure(value) {
      if (this.disposed || !this.context.check()) return;
      this.enabled = Boolean(value.screenTranslation);
      this.interval = ([2, 3, 5, 10].includes(value.screenInterval) ? value.screenInterval : 3) * 1000;
      if (this.toggle) {
        this.toggle.textContent = "화면 번역 " + (this.enabled ? "ON" : "OFF");
        this.toggle.classList.toggle("on", this.enabled);
        this.toggle.setAttribute("aria-pressed", String(this.enabled));
      }
      this.invalidate();
      this.schedule(0);
    }

    setState(state) {
      if (this.disposed || !this.context.check()) return;
      const active = Boolean(state.wanted);
      if (this.active !== active || this.sessionId !== state.sessionId) this.invalidate();
      this.active = active;
      this.sessionId = state.sessionId;
      this.schedule();
    }

    invalidate() {
      this.epoch++;
      this.items = [];
      this.previous = this.requested = null;
      this.nextAt = 0;
      this.emptyFrames = 0;
      this.layoutKey = null;
      this.layer.replaceChildren();
      this.note("");
    }

    note(text) { this.status.textContent = text; this.status.hidden = !text; }

    schedule(delay = 650) {
      if (this.disposed || !this.context.check()) return;
      if (this.timer) return;
      if (!this.active || !this.enabled || document.hidden) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.tick().catch(error => {
          if (!this.disposed) this.note(error.message);
        }).finally(() => this.schedule());
      }, delay);
    }

    rectangle(video) {
      const rect = video.getBoundingClientRect();
      const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
      const width = video.videoWidth * scale, height = video.videoHeight * scale;
      return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height };
    }

    async frame(video) {
      const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
      this.canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      this.canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = this.canvas.getContext("2d");
      try {
        context.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
        return this.canvas.toDataURL("image/jpeg", 0.82);
      } catch (error) {
        if (error.name !== "SecurityError") throw error;
        // Reset a tainted canvas, then use an active-tab screenshot cropped in the extension.
        this.canvas.width = this.canvas.width;
        this.host.style.visibility = "hidden";
        try {
          const result = await this.send("CAPTURE_FRAME", { sessionId: this.sessionId,
            rect: { ...this.rectangle(video), viewportWidth: innerWidth, viewportHeight: innerHeight } });
          if (result?.error) throw Object.assign(new Error(result.error), { retryAfter: result.retryAfter });
          const image = new Image();
          image.src = result.image;
          await image.decode();
          context.drawImage(image, 0, 0, this.canvas.width, this.canvas.height);
          this.screenshot = true;
          return result.image;
        } finally { this.host.style.visibility = ""; }
      }
    }

    pixels(source) {
      this.sampleContext.drawImage(source, 0, 0, 64, 36);
      return this.sampleContext.getImageData(0, 0, 64, 36).data;
    }

    async tick() {
      if (this.disposed || !this.context.check()) return;
      if (!this.active || !this.enabled || document.hidden || this.checking) return;
      if (Date.now() < this.retryAt) return;
      const video = this.video();
      if (!video || video.readyState < 2 || !video.videoWidth || video.seeking) return;
      if (video !== this.lastVideo) { this.invalidate(); this.lastVideo = video; this.screenshot = false; }
      if (this.screenshot && (this.inFlight || Date.now() < this.nextAt)) return;
      const epoch = this.epoch;
      this.checking = true;
      try {
        let image, pixels;
        try {
          if (this.screenshot) {
            image = await this.frame(video);
            pixels = this.pixels(this.canvas);
          } else {
            // Scene checks need only 64x36 pixels, not a full JPEG encoding.
            pixels = this.pixels(video);
          }
        } catch (error) {
          if (error.name !== "SecurityError") throw error;
          this.sample.width = 64;
          image = await this.frame(video);
          pixels = this.pixels(this.canvas);
        }
        if (epoch !== this.epoch || !this.active || !this.enabled || document.hidden) return;
        this.previous = pixels;
        this.items = this.items.filter(item => distance(item.pixels, pixels, item.box) < 0.16);
        this.layout();
        // A new scene or concentrated text-sized change ends the no-text slow scan.
        if (this.emptyFrames && changed(this.requested, pixels, true) && Date.now() >= this.lastRequestAt + this.interval) {
          this.emptyFrames = 0;
          this.nextAt = 0;
        }
        if (this.inFlight || Date.now() < this.nextAt || !changed(this.requested, pixels)) return;
        image ??= await this.frame(video);
        if (epoch !== this.epoch || !this.active || !this.enabled || document.hidden) return;
        this.requested = pixels;
        this.nextAt = Date.now() + this.interval;
        this.lastRequestAt = Date.now();
        this.inFlight = true;
        this.note("화면 번역 중…");
        const started = performance.now();
        void this.send("SCREEN_FRAME", { sessionId: this.sessionId, image }).then(result => {
          if (epoch !== this.epoch || video !== this.video() || !this.active || !this.enabled || document.hidden) return;
          if (result?.error) throw Object.assign(new Error(result.error), { retryAfter: result.retryAfter });
          this.emptyFrames = result.items?.length ? 0 : Math.min(3, this.emptyFrames + 1);
          if (this.emptyFrames) this.nextAt = Math.max(this.nextAt,
            this.lastRequestAt + Math.min(15000, this.interval * 2 ** this.emptyFrames));
          const items = (result.items || []).filter(item =>
            Array.isArray(item.box) && item.box.length === 4 && typeof item.english === "string" &&
            distance(pixels, this.previous, item.box) < 0.16)
            .sort((a, b) => a.box[0] - b.box[0] || a.box[1] - b.box[1]);
          // Keep surviving text's number and color when another phrase disappears.
          const used = new Set();
          this.items = items.map(item => {
            const previous = this.items.find(old => old.source === item.source && !used.has(old.pair) &&
              old.box.every((coordinate, index) => Math.abs(coordinate - item.box[index]) < 80));
            const pair = previous?.pair;
            if (pair != null) used.add(pair);
            return { ...item, pixels, pair };
          });
          for (const item of this.items) {
            if (item.pair != null) continue;
            let pair = 0;
            while (used.has(pair)) pair++;
            item.pair = pair;
            used.add(pair);
          }
          this.note(this.items.length ? "화면 EN · " + ((performance.now() - started) / 1000).toFixed(1) + "초" : "");
          this.layout();
        }).catch(error => {
          if (epoch !== this.epoch) return;
          this.note(error.message);
          this.requested = null;
          this.retryAt = Date.now() + Math.max(15, error.retryAfter || 0) * 1000;
          this.nextAt = this.retryAt;
        }).finally(() => { this.inFlight = false; });
      } catch (error) {
        if (epoch !== this.epoch || !this.active || !this.enabled || document.hidden) return;
        this.note(error.message || "영상 화면을 읽지 못했습니다.");
        this.nextAt = Date.now() + 15000;
        this.screenshot = true;
      } finally { this.checking = false; }
    }

    layout() {
      if (this.disposed || !this.context.check()) return;
      const video = this.video();
      if (!video?.videoWidth || !this.items.length) {
        this.layoutKey = null;
        if (this.layer.childElementCount) this.layer.replaceChildren();
        return;
      }
      const host = this.host.getBoundingClientRect(), rect = this.rectangle(video);
      const offsetX = rect.x - host.x, offsetY = rect.y - host.y;
      const boxes = this.items.map(item => ({
        x: offsetX + item.box[1] * rect.width / 1000, y: offsetY + item.box[0] * rect.height / 1000,
        width: (item.box[3] - item.box[1]) * rect.width / 1000,
        height: (item.box[2] - item.box[0]) * rect.height / 1000,
      }));
      const occupied = [...boxes, ...boxes.map(box => ({
        x: Math.max(1, box.x - 3), y: Math.max(1, box.y - 3) >= 22 ? box.y - 24 : Math.max(1, box.y - 3),
        width: 18, height: 18,
      }))];
      for (const selector of [".controls", ".badge", ".caption", ".panel", ".screen-state"]) {
        const element = this.shadow.querySelector(selector);
        if (!element || element.hidden) continue;
        const bounds = element.getBoundingClientRect();
        occupied.push({ x: bounds.x - host.x, y: bounds.y - host.y, width: bounds.width, height: bounds.height });
      }
      const layoutKey = JSON.stringify([host.width, host.height, occupied,
        this.items.map(item => [item.pair, item.source, item.english])]);
      if (this.layoutKey === layoutKey) return;
      this.layoutKey = layoutKey;
      this.layer.replaceChildren();
      this.items.forEach((item, index) => {
        const source = boxes[index], label = document.createElement("div");
        const pair = item.pair ?? index;
        const color = pairColors[pair % pairColors.length];
        const number = String(pair + 1);
        label.className = "screen-label";
        label.dataset.pair = number;
        label.style.setProperty("--pair-color", color);
        const badge = document.createElement("span"), text = document.createElement("span");
        badge.className = "screen-number";
        badge.textContent = number;
        badge.setAttribute("aria-hidden", "true");
        text.className = "screen-english";
        text.textContent = item.english;
        label.append(badge, text);
        label.title = item.source;
        label.style.width = Math.min(240, Math.max(100, host.width * 0.3)) + "px";
        label.style.visibility = "hidden";
        this.layer.append(label);
        const width = label.offsetWidth, height = label.offsetHeight;
        const centerY = source.y + (source.height - height) / 2;
        const centerX = source.x + (source.width - width) / 2;
        const candidates = [
          { x: source.x + source.width + 10, y: centerY },
          { x: source.x - width - 10, y: centerY },
          { x: centerX, y: source.y + source.height + 10 },
          { x: centerX, y: source.y - height - 10 },
        ].map(position => ({
          x: Math.max(6, Math.min(host.width - width - 6, position.x)),
          y: Math.max(6, Math.min(host.height - height - 6, position.y)), width, height,
        }));
        const fits = candidate => candidate.width <= host.width - 12 &&
          candidate.height <= host.height - 12 && !occupied.some(other => overlaps(candidate, other));
        let placement = candidates.find(fits);
        if (!placement && width <= host.width - 12 && height <= host.height - 12) {
          const alternatives = [];
          for (let y = 6; y <= host.height - height - 6; y += Math.max(12, height / 2)) {
            for (const x of [6, Math.max(6, Math.min(host.width - width - 6, centerX)), host.width - width - 6]) {
              const candidate = { x, y, width, height };
              if (fits(candidate)) alternatives.push(candidate);
            }
          }
          alternatives.sort((a, b) => Math.hypot(a.x - centerX, a.y - centerY) - Math.hypot(b.x - centerX, b.y - centerY));
          placement = alternatives[0];
        }
        if (!placement) { label.remove(); return; }
        occupied.push(placement);
        const outline = document.createElement("div"), marker = document.createElement("span");
        outline.className = "screen-source";
        outline.dataset.pair = number;
        outline.setAttribute("aria-hidden", "true");
        outline.style.setProperty("--pair-color", color);
        const left = Math.max(1, source.x - 3), top = Math.max(1, source.y - 3);
        Object.assign(outline.style, {
          left: left + "px", top: top + "px",
          width: Math.max(0, Math.min(host.width - 1, source.x + source.width + 3) - left) + "px",
          height: Math.max(0, Math.min(host.height - 1, source.y + source.height + 3) - top) + "px",
        });
        marker.className = "screen-number screen-source-number";
        marker.textContent = number;
        marker.style.left = "-2px";
        marker.style.top = top >= 22 ? "-21px" : "0px";
        outline.append(marker);
        this.layer.prepend(outline);
        label.style.left = placement.x + "px";
        label.style.top = placement.y + "px";
        label.style.visibility = "";
      });
    }
  }
  globalThis.CaptionScreen = ScreenText;
})();
