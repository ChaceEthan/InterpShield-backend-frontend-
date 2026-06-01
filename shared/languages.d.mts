export interface SharedLanguage {
  code: string;
  name: string;
  region: string;
  providers: string[];
}

export const LANGUAGE_CATALOG: readonly SharedLanguage[];
export const LANGUAGE_ALIASES: Readonly<Record<string, string>>;
export const SUPPORTED_LANGUAGE_CODES: ReadonlySet<string>;
export const LANGUAGE_NAMES: Readonly<Record<string, string>>;
export const LANGUAGE_FLAGS: Readonly<Record<string, string>>;
export const SPEECH_SYNTHESIS_LANGS: Readonly<Record<string, string>>;
export function normalizeLanguageCode(language?: string): string;
export function providerLanguageCode(language?: string, provider?: string): string;
export function supportedLanguageList(): string;

