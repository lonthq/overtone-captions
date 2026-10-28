import { describe, expect, it } from 'vitest';
import { canonicalLanguage, detectLanguage, normalizeLanguageCode } from '../src/text/detect.js';

/** The same short talk in each language, so related languages are tested against each other. */
const PARALLEL: Record<string, string> = {
  en: 'I am so happy to be here today. We are going to talk about the new product, and I think it is a good idea. It is not hard, but it takes a little time.',
  nl: 'Ik ben zo blij om hier vandaag te zijn. We gaan het over het nieuwe product hebben, en ik denk dat het een goed idee is. Het is niet moeilijk, maar het kost wat tijd.',
  de: 'Ich bin so froh, heute hier zu sein. Wir sprechen über das neue Produkt, und ich glaube, dass es eine gute Idee ist. Es ist nicht schwer, aber es dauert ein bisschen.',
  fr: "Je suis très content d'être ici aujourd'hui. Nous allons parler du nouveau produit, et je pense que c'est une bonne idée. Ce n'est pas difficile, mais cela prend un peu de temps.",
  es: 'Estoy muy contento de estar aquí hoy. Vamos a hablar del nuevo producto, y creo que es una buena idea. No es difícil, pero lleva un poco de tiempo.',
  it: "Sono molto contento di essere qui oggi. Parleremo del nuovo prodotto, e penso che sia una buona idea. Non è difficile, ma ci vuole un po' di tempo.",
  pt: 'Estou muito feliz por estar aqui hoje. Vamos falar sobre o novo produto, e acho que é uma boa ideia. Não é difícil, mas leva um pouco de tempo.',
};

/** Languages we do not detect: a wrong locale is worse than none, so these must give undefined. */
const UNSUPPORTED: Record<string, string> = {
  da: 'Jeg er så glad for at være her i dag. Vi skal tale om det nye produkt, og jeg tror, at det er en god idé. Det er ikke svært, men det tager lidt tid.',
  nb: 'Jeg er så glad for å være her i dag. Vi skal snakke om det nye produktet, og jeg tror at det er en god idé. Det er ikke vanskelig, men det tar litt tid.',
  sv: 'Jag är så glad att vara här i dag. Vi ska prata om den nya produkten, och jag tror att det är en bra idé. Det är inte svårt, men det tar lite tid.',
  af: "Ek is so bly om vandag hier te wees. Ons gaan oor die nuwe produk praat, en ek dink dit is 'n goeie idee. Dit is nie moeilik nie, maar dit neem 'n bietjie tyd.",
  ro: 'Sunt foarte bucuros să fiu aici astăzi. Vom vorbi despre noul produs și cred că este o idee bună. Nu este greu, dar durează puțin timp.',
  ca: 'Estic molt content de ser aquí avui. Parlarem del nou producte, i crec que és una bona idea. No és difícil, però triga una mica de temps.',
  song: 'Oh yeah, oh yeah, la la la, na na na.',
};

describe('detectLanguage', () => {
  it.each(Object.entries(PARALLEL))('recognizes %s in the parallel paragraph', (lang, text) => {
    expect(detectLanguage(text)).toBe(lang);
  });

  it.each([
    ['en', 'So this is the part where we tell you what the product does and why you should care about it.'],
    ['nl', 'Dit is een test van de nieuwe app en het werkt echt goed, maar we hebben nog niet alles gezien.'],
    ['de', 'Das ist ein Test, und ich glaube nicht, dass wir schon alles gesehen haben, aber es ist gut.'],
    ['fr', "C'est un test et je pense que nous avons vu les choses les plus importantes dans la vidéo."],
    ['es', 'Esto es una prueba y creo que no hemos visto todo, pero el producto es muy bueno para los clientes.'],
    ['it', 'Questo è un test e penso che non abbiamo visto tutto, ma il prodotto è molto buono per noi.'],
    ['pt', 'Isso é um teste e eu acho que não vimos tudo, mas o produto é muito bom para você e para nós.'],
  ])('recognizes %s in another sentence', (lang, text) => {
    expect(detectLanguage(text)).toBe(lang);
  });

  it.each(Object.entries(UNSUPPORTED))('returns undefined for %s', (_lang, text) => {
    expect(detectLanguage(text)).toBeUndefined();
  });

  it('returns undefined when unsure', () => {
    expect(detectLanguage('')).toBeUndefined();
    expect(detectLanguage('Hello there. Hi Maya!')).toBeUndefined();
    expect(detectLanguage('CarCover DriveCover 2026 €12')).toBeUndefined();
    expect(detectLanguage('Привет, как дела? Всё хорошо, спасибо.')).toBeUndefined();
    // stopwords, but too few of them among many other words
    expect(detectLanguage('The CarCover DriveCover RoofBox TrunkMate SeatSaver WheelGuard MirrorCap DoorShield and the KeyFob.')).toBeUndefined();
  });
});

/** Another talk per language: supported ones are detected, related unsupported ones give undefined. */
const MORE: Array<[string, string]> = [
  ['en', 'Welcome back to the show. Today we have a great guest with us, and she will tell us how she started her company from nothing.'],
  ['en', 'If you want to save money on your insurance, you should compare the prices before you sign anything.'],
  ['nl', 'Welkom terug bij de show. Vandaag hebben we een geweldige gast, en zij gaat ons vertellen hoe ze haar bedrijf is begonnen.'],
  ['nl', 'Als je geld wilt besparen op je verzekering, moet je eerst de prijzen vergelijken voordat je iets tekent.'],
  ['de', 'Willkommen zurück in der Sendung. Heute haben wir einen tollen Gast, und sie erzählt uns, wie sie ihre Firma gegründet hat.'],
  ['de', 'Wenn du bei deiner Versicherung Geld sparen willst, solltest du die Preise vergleichen, bevor du etwas unterschreibst.'],
  ['fr', "Bienvenue dans l'émission. Aujourd'hui nous avons une invitée formidable, et elle va nous raconter comment elle a créé son entreprise."],
  ['fr', "Si vous voulez économiser sur votre assurance, il faut comparer les prix avant de signer quoi que ce soit."],
  ['es', 'Bienvenidos de nuevo al programa. Hoy tenemos una invitada increíble, y nos va a contar cómo empezó su empresa desde cero.'],
  ['es', 'Si quieres ahorrar dinero en tu seguro, debes comparar los precios antes de firmar nada.'],
  ['it', "Bentornati alla trasmissione. Oggi abbiamo un'ospite fantastica, e ci racconterà come ha fondato la sua azienda dal nulla."],
  ['it', 'Se vuoi risparmiare sulla tua assicurazione, devi confrontare i prezzi prima di firmare qualsiasi cosa.'],
  ['pt', 'Bem-vindos de volta ao programa. Hoje temos uma convidada incrível, e ela vai nos contar como começou a sua empresa do zero.'],
  ['pt', 'Se você quer economizar no seu seguro, deve comparar os preços antes de assinar qualquer coisa.'],
  ['da', 'Velkommen tilbage til programmet. I dag har vi en fantastisk gæst, og hun vil fortælle os, hvordan hun startede sit firma.'],
  ['nb', 'Velkommen tilbake til programmet. I dag har vi en fantastisk gjest, og hun skal fortelle oss hvordan hun startet firmaet sitt.'],
  ['sv', 'Välkommen tillbaka till programmet. I dag har vi en fantastisk gäst, och hon ska berätta för oss hur hon startade sitt företag.'],
  ['af', 'Welkom terug by die program. Vandag het ons n wonderlike gas, en sy gaan vir ons vertel hoe sy haar besigheid begin het.'],
  ['ro', 'Bine ați revenit la emisiune. Astăzi avem un invitat minunat, și ne va spune cum și-a început compania de la zero.'],
  ['ca', "Benvinguts de nou al programa. Avui tenim una convidada fantàstica, i ens explicarà com va començar la seva empresa des de zero."],
];

describe('detectLanguage on more sentences', () => {
  it.each(MORE)('%s: %s', (lang, text) => {
    expect(detectLanguage(text)).toBe(['da', 'nb', 'sv', 'af', 'ro', 'ca'].includes(lang) ? undefined : lang);
  });
});

describe('normalizeLanguageCode', () => {
  it.each([
    ['en', 'en'], ['nl-NL', 'nl'], ['NL', 'nl'], ['pt_BR', 'pt'], ['dutch', 'nl'], ['English', 'en'],
    ['', undefined], [undefined, undefined], ['not a language', undefined], ['x1', undefined],
  ])('%s → %s', (input, out) => {
    expect(normalizeLanguageCode(input)).toBe(out);
  });
});

describe('canonicalLanguage (for --language)', () => {
  it.each([
    ['nl', 'nl'], ['NL', 'nl'], ['nl-be', 'nl-BE'], ['nl_BE', 'nl-BE'], ['zh-hant-tw', 'zh-Hant-TW'], ['dutch', 'nl'], ['German', 'de'], ['fil', 'fil'],
  ])('%s → %s', (input, out) => {
    expect(canonicalLanguage(input)).toBe(out);
  });
  it.each(['klingon', 'nl-', 'n', 'en us', '12', 'x1'])('rejects %s', (input) => {
    expect(canonicalLanguage(input)).toBeUndefined();
  });
});
