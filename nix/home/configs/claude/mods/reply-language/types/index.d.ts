declare module 'claude-code' {
  interface PluginState {
    /** `isNotKorean`: the last main answer held no Hangul syllable; the next prompt carries a reminder once. */
    'reply-language': { isNotKorean: boolean }
  }
}
