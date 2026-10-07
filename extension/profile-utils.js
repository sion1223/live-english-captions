// Exact owner identities only: video titles and recommendation links must never
// select a channel profile.
globalThis.CaptionProfiles = {
  identity(value = "") {
    try {
      const url = new URL(value, "https://www.youtube.com");
      if (!["youtube.com", "www.youtube.com"].includes(url.hostname)) return "";
      const path = decodeURIComponent(url.pathname).replace(/\/+$/, "");
      const match = path.match(/^\/(@[^/]+|channel\/UC[A-Za-z0-9_-]+)$/);
      return match ? match[1].toLowerCase() : "";
    } catch { return ""; }
  },
  select(profiles, channel = {}) {
    const identity = this.identity(channel.ownerUrl);
    if (!identity || !channel.videoId) return null;
    return profiles.find(profile => {
      const identities = ["channel/" + profile.channelId, ...profile.handles.map(handle => "@" + handle)];
      return identities.some(value => value.toLowerCase() === identity);
    }) || null;
  },
  summary(profile) {
    return profile ? { id: profile.id, name: profile.name, vocabularyCount: profile.vocabulary.length,
      sourceCount: profile.sources.length } : null;
  },
};
