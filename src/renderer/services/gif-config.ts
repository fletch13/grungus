/** Vite embeds the application owner's client API key at build time. */
export const sharedKlipyApiKey = import.meta.env.VITE_KLIPY_API_KEY?.trim() ?? "";
export function configuredKlipyApiKey(personalKey: string): string {
  return personalKey.trim() || sharedKlipyApiKey;
}
