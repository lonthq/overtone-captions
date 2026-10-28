/**
 * Detection decoys: stopwords of languages close to a detected one that have no detection yet. They are scored but
 * never returned; a decoy that wins or comes close makes the guess undefined, so Danish is not taken for Dutch or
 * Catalan for Spanish. When a pack gains detection, move its list there (the pack test fails while it is in both).
 */
export const DECOYS: Readonly<Record<string, readonly string[]>> = {
  // Danish
  da: [
    'jeg', 'er', 'så', 'for', 'at', 'være', 'her', 'i', 'dag', 'vi', 'skal', 'om', 'det', 'og', 'en', 'et', 'ikke',
    'men', 'lidt', 'tror', 'god', 'den', 'de', 'med', 'til', 'på', 'har', 'som', 'af', 'han', 'hun', 'der', 'meget',
    'nye', 'tager', 'svært', 'tale', 'kan', 'også', 'hvad',
  ],
  // Norwegian Bokmål
  nb: [
    'jeg', 'er', 'så', 'for', 'å', 'være', 'her', 'i', 'dag', 'vi', 'skal', 'om', 'det', 'og', 'en', 'et', 'ikke',
    'men', 'litt', 'tror', 'god', 'den', 'de', 'med', 'til', 'på', 'har', 'som', 'av', 'han', 'hun', 'der', 'mye',
    'nye', 'tar', 'vanskelig', 'snakke', 'kan', 'også', 'hva', 'at',
  ],
  // Swedish
  sv: [
    'jag', 'är', 'så', 'att', 'vara', 'här', 'i', 'dag', 'vi', 'ska', 'om', 'det', 'och', 'en', 'ett', 'inte', 'men',
    'lite', 'tror', 'bra', 'den', 'de', 'med', 'till', 'på', 'har', 'som', 'av', 'han', 'hon', 'mycket', 'nya', 'tar',
    'svårt', 'prata', 'kan', 'också', 'vad', 'för',
  ],
  // Afrikaans
  af: [
    'ek', 'is', 'so', 'om', 'te', 'wees', 'ons', 'gaan', 'oor', 'die', 'nuwe', 'en', 'dink', 'dit', 'n', 'nie',
    'maar', 'neem', 'bietjie', 'hy', 'sy', 'hulle', 'was', 'het', 'vir', 'met', 'van', 'op', 'ook', 'nog', 'kan',
    'sal', 'moet', 'baie', 'jy', 'julle', 'wat', 'hier', 'daar', 'nou', 'bly', 'vandag', 'goeie', 'moeilik', 'praat',
  ],
  // Romanian
  ro: [
    'și', 'este', 'un', 'o', 'de', 'la', 'în', 'că', 'nu', 'pe', 'cu', 'pentru', 'care', 'mai', 'sunt', 'din', 'sau',
    'ce', 'acest', 'această', 'foarte', 'dar', 'am', 'eu', 'noi', 'ei', 'al', 'ale', 'lui', 'fi', 'fost', 'cum',
    'aici', 'astăzi', 'vom', 'vorbi', 'despre', 'cred', 'bună', 'greu', 'puțin', 'să', 'fiu', 'noul', 'timp',
  ],
  // Catalan
  ca: [
    'i', 'és', 'el', 'la', 'els', 'les', 'un', 'una', 'de', 'que', 'no', 'en', 'per', 'amb', 'però', 'molt', 'jo',
    'nosaltres', 'del', 'al', 'això', 'aquest', 'aquesta', 'també', 'hi', 'ha', 'estic', 'aquí', 'avui', 'crec',
    'mica', 'com', 'més', 'ser', 'nou', 'bona', 'parlarem', 'temps',
  ],
};
