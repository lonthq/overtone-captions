// Minimal types for the vtt.js parser used by the WebVTT round-trip test.
declare module 'videojs-vtt.js' {
  interface ParsedCue { startTime: number; endTime: number; text: string }
  interface Parser {
    oncue: (cue: ParsedCue) => void;
    onparsingerror: (error: unknown) => void;
    parse(text: string): void;
    flush(): void;
  }
  const vttjs: {
    WebVTT: {
      Parser: new (window: Window, decoder: unknown) => Parser;
      StringDecoder(): unknown;
    };
  };
  export default vttjs;
}
