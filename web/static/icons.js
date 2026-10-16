// 24px stroke icons in the Lucide style (ISC-licensed geometry).
const paths = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  circle: '<circle cx="12" cy="12" r="9"/>',
  circleDashed: '<path d="M10.1 2.2a10 10 0 0 1 3.8 0"/><path d="M17.6 3.7a10 10 0 0 1 2.7 2.7"/><path d="M21.8 10.1a10 10 0 0 1 0 3.8"/><path d="M20.3 17.6a10 10 0 0 1-2.7 2.7"/><path d="M13.9 21.8a10 10 0 0 1-3.8 0"/><path d="M6.4 20.3a10 10 0 0 1-2.7-2.7"/><path d="M2.2 13.9a10 10 0 0 1 0-3.8"/><path d="M3.7 6.4a10 10 0 0 1 2.7-2.7"/>',
  circleCheck: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  circleX: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>',
  skip: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="1"/>',
  squareCheck: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
};

export function icon(name, className = "") {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ""}</svg>`;
}

export const statusIcons = {
  pending: "circleDashed",
  running: "loader",
  waiting: "hand",
  done: "circleCheck",
  failed: "circleX",
  skipped: "skip",
};
