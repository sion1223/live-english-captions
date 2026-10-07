(() => {
  if (globalThis.CaptionContext) return;
  globalThis.CaptionContext = class {
    static notice = "확장 프로그램이 업데이트됐습니다. 유튜브 탭을 새로고침해 주세요.";

    constructor(onInvalidated) {
      this.onInvalidated = onInvalidated;
      this.invalidated = false;
    }

    invalidate() {
      if (this.invalidated) return;
      this.invalidated = true;
      this.onInvalidated();
    }

    check() {
      if (!this.invalidated) {
        try { if (chrome.runtime?.id) return true; } catch { /* The extension was unloaded. */ }
      }
      this.invalidate();
      return false;
    }

    async call(operation) {
      if (!this.check()) throw new Error(CaptionContext.notice);
      try {
        // Chrome may throw before returning a Promise when the old page survives a reload.
        const result = await operation();
        if (!this.check()) throw new Error(CaptionContext.notice);
        return result;
      } catch (error) {
        if (/extension context invalidated/i.test(error?.message || "") || !this.check()) {
          this.invalidate();
          throw new Error(CaptionContext.notice);
        }
        throw error;
      }
    }
  };
})();
