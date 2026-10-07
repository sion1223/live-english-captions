globalThis.CaptionStyle = {
  defaults: { fontSize: 24, maxWidth: 80 },
  normalize(value = {}) {
    const number = (input, fallback, min, max) =>
      Number.isFinite(Number(input)) ? Math.min(max, Math.max(min, Math.round(Number(input)))) : fallback;
    return {
      fontSize: number(value.fontSize ?? 24, 24, 16, 42),
      maxWidth: number(value.maxWidth ?? 80, 80, 45, 95),
    };
  },
};
