import { desktopBridge } from './native.js';

const PORTUGUESE_HINTS = /(?:[ãõçáéíóúâêôà]|\b(?:não|você|vocês|para|uma|um|que|com|como|mais|isso|está|estão|pode|posso|meu|minha|seu|sua|receita|obrigado|obrigada)\b)/i;
const QUALITY_VOICE = /(?:premium|enhanced|natural|neural)/i;

function speechLanguage(text: string): string {
  if (PORTUGUESE_HINTS.test(text)) return 'pt-BR';
  const browserLanguage = navigator.language?.trim();
  return browserLanguage || 'en-US';
}

function chooseVoice(
  voices: SpeechSynthesisVoice[],
  language: string
): SpeechSynthesisVoice | undefined {
  const exact = language.toLowerCase();
  const base = exact.split('-')[0] ?? exact;
  const sameLanguage = voices.filter((voice) => voice.lang.toLowerCase() === exact);
  const sameBase = voices.filter((voice) => voice.lang.toLowerCase().startsWith(`${base}-`));

  return sameLanguage.find((voice) => voice.localService && QUALITY_VOICE.test(voice.name))
    ?? sameLanguage.find((voice) => voice.localService)
    ?? sameLanguage.find((voice) => QUALITY_VOICE.test(voice.name))
    ?? sameLanguage[0]
    ?? sameBase.find((voice) => voice.localService && QUALITY_VOICE.test(voice.name))
    ?? sameBase.find((voice) => voice.localService)
    ?? sameBase.find((voice) => QUALITY_VOICE.test(voice.name))
    ?? sameBase[0]
    ?? voices.find((voice) => voice.default);
}

function installNativeClipboard(): void {
  const bridge = desktopBridge();
  if (!bridge?.copyText) return;

  const writeText = async (text: string): Promise<void> => {
    await bridge.copyText(String(text));
  };

  try {
    if (navigator.clipboard) {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: writeText
      });
      return;
    }
  } catch {
    // Fall through and install a minimal Clipboard-compatible surface.
  }

  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
  } catch {
    // The renderer can still use keyboard/menu copy if Chromium seals navigator.
  }
}

function installNaturalSpeechDefaults(): void {
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return;
  const synth = window.speechSynthesis;
  const originalSpeak = synth.speak.bind(synth);

  synth.speak = (utterance: SpeechSynthesisUtterance): void => {
    const language = speechLanguage(utterance.text);
    const voice = utterance.voice ?? chooseVoice(synth.getVoices(), language);
    if (voice) utterance.voice = voice;
    if (!utterance.lang) utterance.lang = voice?.lang ?? language;
    if (utterance.rate === 1) utterance.rate = 0.96;
    originalSpeak(utterance);
  };
}

export function installChatPlatformEnhancements(): void {
  installNativeClipboard();
  installNaturalSpeechDefaults();
}
