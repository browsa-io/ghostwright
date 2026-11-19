// Key definitions for Input.dispatchKeyEvent (US layout).

export interface KeyDef { key: string; code: string; vk: number; text?: string; shift?: boolean }

export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

export const NAMED_KEYS: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  insert: { key: "Insert", code: "Insert", vk: 45 },
};

export const MODIFIER_KEYS: Record<string, { def: KeyDef; bit: number }> = {
  control: { def: { key: "Control", code: "ControlLeft", vk: 17 }, bit: MOD.ctrl },
  ctrl: { def: { key: "Control", code: "ControlLeft", vk: 17 }, bit: MOD.ctrl },
  shift: { def: { key: "Shift", code: "ShiftLeft", vk: 16 }, bit: MOD.shift },
  alt: { def: { key: "Alt", code: "AltLeft", vk: 18 }, bit: MOD.alt },
  option: { def: { key: "Alt", code: "AltLeft", vk: 18 }, bit: MOD.alt },
  meta: { def: { key: "Meta", code: "MetaLeft", vk: 91 }, bit: MOD.meta },
  cmd: { def: { key: "Meta", code: "MetaLeft", vk: 91 }, bit: MOD.meta },
  command: { def: { key: "Meta", code: "MetaLeft", vk: 91 }, bit: MOD.meta },
};

const SYMBOLS: Record<string, [string, number, boolean?]> = {
  " ": ["Space", 32], "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219], "]": ["BracketRight", 221],
  "\\": ["Backslash", 220], ";": ["Semicolon", 186], "'": ["Quote", 222], ",": ["Comma", 188], ".": ["Period", 190],
  "/": ["Slash", 191], "`": ["Backquote", 192], _: ["Minus", 189, true], "+": ["Equal", 187, true],
  "{": ["BracketLeft", 219, true], "}": ["BracketRight", 221, true], "|": ["Backslash", 220, true],
  ":": ["Semicolon", 186, true], '"': ["Quote", 222, true], "<": ["Comma", 188, true], ">": ["Period", 190, true],
  "?": ["Slash", 191, true], "~": ["Backquote", 192, true], "!": ["Digit1", 49, true], "@": ["Digit2", 50, true],
  "#": ["Digit3", 51, true], $: ["Digit4", 52, true], "%": ["Digit5", 53, true], "^": ["Digit6", 54, true],
  "&": ["Digit7", 55, true], "*": ["Digit8", 56, true], "(": ["Digit9", 57, true], ")": ["Digit0", 48, true],
};

/** The key for a printable character, or null when it is not on a US keyboard. */
export function charKey(ch: string): KeyDef | null {
  if (ch >= "a" && ch <= "z") return { key: ch, code: "Key" + ch.toUpperCase(), vk: ch.toUpperCase().charCodeAt(0), text: ch };
  if (ch >= "A" && ch <= "Z") return { key: ch, code: "Key" + ch, vk: ch.charCodeAt(0), text: ch, shift: true };
  if (ch >= "0" && ch <= "9") return { key: ch, code: "Digit" + ch, vk: ch.charCodeAt(0), text: ch };
  const s = SYMBOLS[ch];
  if (s) return { key: ch, code: s[0], vk: s[1], text: ch, shift: !!s[2] };
  return null;
}

export interface KeyCombo { mods: number; key: KeyDef }

/** "Enter", "Control+A", "Shift+Tab" or a sequence of those ("Tab Tab Enter"). */
export function parseKeys(s: string): KeyCombo[] {
  const out: KeyCombo[] = [];
  for (const tok of s.trim().split(/\s+/).filter(Boolean)) {
    let parts = tok.split("+");
    if (tok === "+") parts = ["+"];
    else if (tok.endsWith("++")) parts = [...tok.slice(0, -2).split("+"), "+"];
    const c: KeyCombo = { mods: 0, key: { key: "", code: "", vk: 0 } };
    parts.forEach((p, i) => {
      const lp = p.toLowerCase();
      if (i < parts.length - 1) {
        const m = MODIFIER_KEYS[lp];
        if (!m) throw new Error(`unknown modifier "${p}" in "${tok}"`);
        c.mods |= m.bit;
        return;
      }
      if (NAMED_KEYS[lp]) c.key = NAMED_KEYS[lp];
      else if (MODIFIER_KEYS[lp]) c.key = MODIFIER_KEYS[lp].def;
      else if (/^f([1-9]|1[0-2])$/.test(lp)) { const n = +lp.slice(1); c.key = { key: "F" + n, code: "F" + n, vk: 111 + n }; }
      else if ([...p].length === 1) {
        const k = charKey(p);
        if (!k) throw new Error(`unknown key "${p}"`);
        c.key = c.mods & ~MOD.shift ? { ...k, text: undefined } : k;
      } else throw new Error(`unknown key "${p}"`);
    });
    out.push(c);
  }
  if (!out.length) throw new Error("no keys given");
  return out;
}
