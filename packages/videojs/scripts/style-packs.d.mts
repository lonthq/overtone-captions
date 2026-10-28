// Types for style-packs.mjs (used by the tests).
export interface Color { r: number; g: number; b: number; a: number }
export interface Declaration { property: string; value: string; important: boolean }
export interface Rule { selector: string; body: string; declarations: Declaration[]; atRules: string[] }
export interface AtRule { prelude: string; context: string[]; statement: boolean }
export interface PackMeta {
  $schema?: string;
  name: string;
  title: string;
  description: string;
  author: string;
  license: string;
  tags: string[];
  contrast: string;
}
export interface Pack { name: string; dir: string; meta: PackMeta | null; css: string | null; preview: string | null }
export interface ContrastCheck { label: string; variable: string; fg: string; bg: string; ratio: number }
export interface ContrastReport { mode: 'box' | 'outline' | 'unknown'; checks: ContrastCheck[]; problems: string[] }
export interface ManifestEntry extends Omit<PackMeta, '$schema'> { css: string; source: string; lowestContrast: number | null }

export function listPacks(stylesDir: string): string[];
export function readPack(dir: string, name: string): Pack;
export function parseCss(css: string): { rules: Rule[]; atRules: AtRule[] };
export function layerRuleShape(selector: string, name: string): '' | 'tall' | `profile:${string}` | null;
export function packProfiles(packCss: string, name: string): string[];
export function packVariables(
  baseCss: string,
  packCss: string,
  name: string,
  options?: { shape?: 'wide' | 'tall'; media?: string | null; profile?: string | null },
): Record<string, string>;
export function parseColor(input: string | undefined): Color | null;
export function contrastRatio(a: Color, b: Color): number;
export function packContrast(
  baseCss: string,
  packCss: string,
  name: string,
  shapes?: Array<'wide' | 'tall'>,
): { variants: Array<ContrastReport & { shape: 'wide' | 'tall'; profile: string | undefined; media: string | null }>; lowest: number | null };
export function buildStylePacks(options: { stylesDir: string; baseCssPath: string; outDir: string }): {
  packs: ManifestEntry[];
};

export const LINT_RULES: Record<string, string>;
/** The format's semantic classes (overtone-format STYLE_CLASSES; a test keeps them in sync). */
export const SEMANTIC_CLASSES: string[];
export function lintStyle(baseCss: string, css: string, name: string): Array<{ rule: string; message: string }>;
