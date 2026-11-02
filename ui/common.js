// Small helpers shared by Alcove's own pages (the sidebar, Settings, Tools, the palette, the start page).

// The accent colour is chosen in Settings and can be light (green, orange, sky blue). Text on it is white or near-black,
// whichever reads better, published as --on-accent for the buttons that sit on the accent.
function setAccent(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return;
  const root = document.documentElement.style;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  root.setProperty("--accent", hex);
  // contrast with white is 1.05 / (L + 0.05); with the near-black text colour #111 (luminance 0.0056) it is (L + 0.05) / 0.0556
  root.setProperty("--on-accent", 1.05 / (L + 0.05) >= (L + 0.05) / 0.0556 ? "#fff" : "#111");
}

// "smooth" unless the person has asked their system for less motion.
const scrollBehavior = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
