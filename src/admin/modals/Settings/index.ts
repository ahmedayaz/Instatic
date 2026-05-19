// Intentionally empty — the only consumers (AdminCanvasLayout and
// AdminPageLayout) import `SettingsModal` directly via React.lazy() so the
// modal lives in its own chunk and only loads on first open. Re-exporting
// it from here would defeat the lazy boundary: rolldown sees a static
// import from a barrel and merges the chunk back into the eager graph.
export {}
