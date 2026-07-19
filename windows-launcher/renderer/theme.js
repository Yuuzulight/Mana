// Theme picker (issue #45): built-in presets plus a manual accent override,
// applied through the same :root CSS custom properties index.html already
// defines (--bg, --panel, --panel-2, --border, --text, --muted, --accent,
// --user-bubble, --mana-bubble) — no other CSS needs to change for a theme
// to take effect.
//
// Loaded early in <head> (before <body>) so the persisted theme applies
// before first paint, then wires up the picker UI once the DOM is ready.
// Shares its global scope with renderer.js/session-sidebar.js (classic
// scripts, not modules).

const THEME_STORAGE_KEY = "manaTheme";
const DEFAULT_THEME_PRESET = "violet";

const THEME_PRESETS = {
  violet: {
    label: "Violet",
    vars: {
      "--bg": "#1c1a18",
      "--panel": "#242220",
      "--panel-2": "#2c2a27",
      "--border": "#3a3733",
      "--text": "#e8e4de",
      "--muted": "#948d84",
      "--accent": "#9d8ce0",
      "--user-bubble": "#3a3560",
      "--mana-bubble": "#2a2725",
    },
  },
  neutral: {
    label: "Neutral dark",
    vars: {
      "--bg": "#18191b",
      "--panel": "#202225",
      "--panel-2": "#2a2d31",
      "--border": "#383c41",
      "--text": "#e8e9eb",
      "--muted": "#9a9ea5",
      "--accent": "#4fb3a8",
      "--user-bubble": "#283838",
      "--mana-bubble": "#212427",
    },
  },
  light: {
    label: "Light",
    vars: {
      "--bg": "#f5f5f7",
      "--panel": "#ffffff",
      "--panel-2": "#eceef3",
      "--border": "#d9dce3",
      "--text": "#1c1c24",
      "--muted": "#6a6e78",
      "--accent": "#7a5fe0",
      "--user-bubble": "#e4e1fb",
      "--mana-bubble": "#eef0f5",
    },
  },
};

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function loadThemeState() {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) {
      return { preset: DEFAULT_THEME_PRESET, accentOverride: null };
    }
    const parsed = JSON.parse(raw);
    const preset = THEME_PRESETS[parsed.preset] ? parsed.preset : DEFAULT_THEME_PRESET;
    const accentOverride =
      typeof parsed.accentOverride === "string" &&
      HEX_COLOR_PATTERN.test(parsed.accentOverride)
        ? parsed.accentOverride
        : null;
    return { preset, accentOverride };
  } catch (e) {
    return { preset: DEFAULT_THEME_PRESET, accentOverride: null };
  }
}

function saveThemeState(state) {
  localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(state));
}

function activeAccent(state) {
  const preset = THEME_PRESETS[state.preset] || THEME_PRESETS[DEFAULT_THEME_PRESET];
  return state.accentOverride || preset.vars["--accent"];
}

function applyTheme(state) {
  const preset = THEME_PRESETS[state.preset] || THEME_PRESETS[DEFAULT_THEME_PRESET];
  const root = document.documentElement.style;
  for (const [name, value] of Object.entries(preset.vars)) {
    root.setProperty(name, value);
  }
  if (state.accentOverride) {
    root.setProperty("--accent", state.accentOverride);
  }
}

let themeState = loadThemeState();
applyTheme(themeState);

function setThemePreset(presetKey) {
  if (!THEME_PRESETS[presetKey]) {
    return;
  }
  themeState = { preset: presetKey, accentOverride: null };
  saveThemeState(themeState);
  applyTheme(themeState);
  renderThemePanel();
}

function setThemeAccentOverride(hexColor) {
  if (!HEX_COLOR_PATTERN.test(hexColor)) {
    return;
  }
  themeState = { ...themeState, accentOverride: hexColor };
  saveThemeState(themeState);
  applyTheme(themeState);
}

function resetThemeAccentOverride() {
  themeState = { ...themeState, accentOverride: null };
  saveThemeState(themeState);
  applyTheme(themeState);
  renderThemePanel();
}

function renderThemePanel() {
  const controlsEl = document.getElementById("themePresetControls");
  const accentInputEl = document.getElementById("accentColorInput");
  if (!controlsEl || !accentInputEl) {
    return;
  }

  controlsEl.innerHTML = "";
  for (const [key, preset] of Object.entries(THEME_PRESETS)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "modelModeButton" + (themeState.preset === key ? " active" : "");
    button.textContent = preset.label;
    button.addEventListener("click", () => setThemePreset(key));
    controlsEl.appendChild(button);
  }

  accentInputEl.value = activeAccent(themeState);
}

document.addEventListener("DOMContentLoaded", () => {
  renderThemePanel();

  const accentInputEl = document.getElementById("accentColorInput");
  const resetAccentBtnEl = document.getElementById("resetAccentBtn");

  accentInputEl?.addEventListener("input", (event) => {
    setThemeAccentOverride(event.target.value);
  });

  resetAccentBtnEl?.addEventListener("click", () => {
    resetThemeAccentOverride();
  });
});
