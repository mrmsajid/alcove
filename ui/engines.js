// Search engines, shared by the sidebar, palette, settings page and the main process.
const ENGINES = {
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s", home: "https://duckduckgo.com" },
  google: { name: "Google", url: "https://www.google.com/search?q=%s", home: "https://www.google.com" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q=%s", home: "https://www.bing.com" },
  brave: { name: "Brave Search", url: "https://search.brave.com/search?q=%s", home: "https://search.brave.com" },
  ecosia: { name: "Ecosia", url: "https://www.ecosia.org/search?q=%s", home: "https://www.ecosia.org" },
  startpage: { name: "Startpage", url: "https://www.startpage.com/do/search?query=%s", home: "https://www.startpage.com" },
  perplexity: { name: "Perplexity", url: "https://www.perplexity.ai/search?q=%s", home: "https://www.perplexity.ai" },
};

// The chosen engine's search URL; a custom engine is any URL containing %s.
function searchTemplate(settings) {
  const s = settings || {};
  if (s.searchEngine === "custom" && /%s/.test(s.customSearch || "")) return s.customSearch;
  return (ENGINES[s.searchEngine] || ENGINES.duckduckgo).url;
}

function searchUrl(settings, query) {
  return searchTemplate(settings).replace("%s", encodeURIComponent(query));
}

function engineHome(settings) {
  const s = settings || {};
  if (s.searchEngine === "custom") {
    try { return new URL(s.customSearch.replace("%s", "")).origin; } catch { return ENGINES.duckduckgo.home; }
  }
  return (ENGINES[s.searchEngine] || ENGINES.duckduckgo).home;
}

if (typeof module !== "undefined") module.exports = { ENGINES, searchTemplate, searchUrl, engineHome };
