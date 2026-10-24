/** Metro resolves a font import to an opaque asset handle. */
declare module '*.ttf' {
  const asset: number;
  export default asset;
}

/** ci-tools' icon check (its README, "Icons"), plain JavaScript. */
declare module '@sabeel-institute/ci-tools/lib/icons.mjs' {
  export function iconProblems(root?: string): Promise<string[]>;
}
