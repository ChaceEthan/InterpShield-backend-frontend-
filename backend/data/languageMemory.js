export const LANGUAGE_NAMES = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  ar: "Arabic",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  hi: "Hindi",
  tr: "Turkish",
  pl: "Polish",
  ru: "Russian",
  rw: "Kinyarwanda",
  rn: "Kirundi",
  sw: "Swahili",
  luganda: "Luganda",
  lg: "Luganda"
};

export const LOCAL_PHRASES = {
  rw: {
    bite: "amakuru",
    "ni sawa": "ni byiza",
    yego: "yego",
    "umeze gute": "amakuru yawe",
    ndabizi: "ndabizi neza",
    urakoze: "murakoze",
    birakomeye: "biragoye",
    "amakuru ki": "amakuru",
    "urakoze cyane": "murakoze cyane",
    "murakoze cyane cyane": "murakoze cyane",
    "nta kibazo": "ntacyo bitwaye"
  },
  rn: {
    amakuru: "amakuru meza",
    ego: "ego cane",
    yego: "ego cane",
    urakoze: "urakoze cane",
    murakoze: "murakoze cane",
    "ni sawa": "ni vyiza",
    "umeze gute": "amakuru yawe",
    ndabizi: "ndabizi neza",
    cyane: "cane",
    "urakoze cyane": "urakoze cane",
    "murakoze cyane": "murakoze cane",
    "amakuru ki": "amakuru meza",
    muraho: "mwaramutse"
  },
  ugandaMix: {
    ssebo: "sir",
    webale: "thank you",
    "webale nyo": "thank you very much",
    "oli otya": "how are you",
    mukwano: "friend",
    banange: "please"
  },
  sw: {
    habari: "habari",
    asante: "asante",
    sawa: "sawa",
    rafiki: "rafiki",
    tafadhali: "tafadhali",
    karibu: "karibu"
  },
  luganda: {
    ssebo: "ssebo",
    nyabo: "nyabo",
    webale: "webale",
    "webale nyo": "webale nyo",
    "oli otya": "oli otya",
    mukwano: "mukwano",
    banange: "banange"
  }
};

export const LOCAL_TRANSLATIONS = {
  en: {
    rw: {
      amakuru: "how are you",
      murakoze: "thank you",
      "murakoze cyane": "thank you very much",
      urakoze: "thank you",
      "urakoze cyane": "thank you very much",
      yego: "yes",
      oya: "no",
      ndabizi: "I know",
      ikibazo: "problem",
      muraho: "hello",
      mwaramutse: "good morning",
      mwiriwe: "good evening",
      bite: "what's up",
      "nta kibazo": "no problem",
      "ntacyo bitwaye": "no problem"
    },
    rn: {
      amakuru: "how are you",
      "amakuru meza": "how are you",
      ego: "yes",
      "ego cane": "yes",
      urakoze: "thank you",
      "urakoze cane": "thank you very much",
      murakoze: "thank you",
      "murakoze cane": "thank you very much",
      cane: "very much",
      amahoro: "hello",
      mwaramutse: "good morning",
      "ni vyiza": "it is good"
    },
    sw: {
      habari: "how are you",
      asante: "thank you",
      "asante sana": "thank you very much",
      sawa: "okay",
      rafiki: "friend",
      tafadhali: "please",
      karibu: "welcome",
      jambo: "hello",
      ndio: "yes",
      hapana: "no"
    },
    luganda: {
      ssebo: "sir",
      nyabo: "madam",
      webale: "thank you",
      "webale nyo": "thank you very much",
      "oli otya": "how are you",
      mukwano: "friend",
      banange: "please",
      gyebale: "well done",
      mpola: "sorry"
    }
  },
  rw: {
    en: {
      "how are you": "amakuru?",
      hello: "muraho",
      "good morning": "mwaramutse",
      "good evening": "mwiriwe",
      "thank you": "murakoze",
      "thank you very much": "murakoze cyane",
      yes: "yego",
      no: "oya",
      "i know": "ndabizi",
      problem: "ikibazo",
      "no problem": "ntacyo bitwaye",
      okay: "ni byiza",
      "it is okay": "ni byiza"
    }
  },
  rn: {
    en: {
      "how are you": "amakuru meza?",
      hello: "amahoro",
      "good morning": "mwaramutse",
      "thank you": "urakoze cane",
      "thank you very much": "urakoze cane",
      yes: "ego cane",
      no: "oya",
      okay: "ni vyiza",
      "it is okay": "ni vyiza",
      "i know": "ndabizi",
      problem: "ikibazo"
    }
  },
  sw: {
    en: {
      "how are you": "habari?",
      hello: "jambo",
      "thank you": "asante",
      "thank you very much": "asante sana",
      okay: "sawa",
      "it is okay": "sawa",
      friend: "rafiki",
      please: "tafadhali",
      yes: "ndio",
      no: "hapana",
      welcome: "karibu"
    }
  },
  luganda: {
    en: {
      "how are you": "oli otya?",
      "thank you": "webale",
      "thank you very much": "webale nyo",
      sir: "ssebo",
      madam: "nyabo",
      friend: "mukwano",
      please: "banange",
      "well done": "gyebale"
    }
  }
};

export const LOCAL_LANGUAGE_MARKERS = {
  rw: {
    phrases: ["murakoze cyane", "nta kibazo", "ntacyo bitwaye", "amakuru", "murakoze", "yego", "ndabizi", "ikibazo", "muraho", "mwaramutse", "mwiriwe", "ndashaka", "bite"],
    words: ["cyane", "ntacyo", "wowe", "njye", "kugira", "ndashaka", "ndabizi"]
  },
  rn: {
    phrases: ["ego cane", "amakuru meza", "urakoze cane", "murakoze cane", "ni vyiza", "amahoro", "ndabaramutsa"],
    words: ["ego", "cane", "vyiza", "ndabaramutsa", "nivyo", "mwaramutse"]
  },
  sw: {
    phrases: ["asante sana", "habari", "asante", "sawa", "rafiki", "tafadhali", "karibu", "jambo"],
    words: ["ndio", "hapana", "nzuri", "sana", "naomba", "kwaheri"]
  },
  luganda: {
    phrases: ["oli otya", "webale nyo", "ssebo", "nyabo", "webale", "mukwano", "banange", "gyebale", "mpola"],
    words: ["naye", "kampala", "luganda", "kale", "tya"]
  },
  en: {
    phrases: ["thank you", "how are you", "good morning", "good evening", "no problem", "i know"],
    words: ["the", "and", "you", "hello", "please", "yes", "no", "problem", "question", "friend", "okay", "thanks"]
  }
};

export const GREETING_INTELLIGENCE = {
  rw: {
    casual: ["amakuru", "bite", "umeze gute", "mwaramutse", "mwiriwe"],
    replacements: {
      "amakuru?": "amakuru?",
      "bite?": "amakuru?",
      "umeze gute?": "amakuru yawe?"
    }
  },
  rn: {
    casual: ["amahoro", "amakuru", "mwaramutse", "mwiriwe"],
    replacements: {
      "amakuru?": "amakuru meza?",
      "ego?": "ego cane?",
      "urakoze.": "urakoze cane."
    }
  }
};

export const CONTEXT_REPLACEMENTS = {
  rw: [
    [/\bni\s+sawa\b/gi, "ni byiza"],
    [/\bego\b/gi, "yego"],
    [/\bumerewe\s+ute\b/gi, "amakuru yawe"],
    [/\burakoze\s+cyane\s+cyane\b/gi, "murakoze cyane"],
    [/\bbirakomeye\b/gi, "biragoye"]
  ],
  rn: [
    [/\bni\s+sawa\b/gi, "ni vyiza"],
    [/\byego\b/gi, "ego"],
    [/\bcyane\b/gi, "cane"],
    [/\burakoze\s+cane\s+cane\b/gi, "urakoze cane"],
    [/\bmurakoze\s+cane\s+cane\b/gi, "murakoze cane"],
    [/\bumerewe\s+ute\b/gi, "amakuru yawe"],
    [/\bmuraho\b/gi, "mwaramutse"]
  ]
};

export const MIXED_SPEECH_TERMS = {
  "ni sawa": "it is okay",
  sawa: "okay",
  ssebo: "sir",
  webale: "thank you",
  "webale nyo": "thank you very much",
  "oli otya": "how are you",
  mukwano: "friend",
  banange: "please",
  "ca va": "how are you",
  merci: "thank you",
  bonjour: "hello",
  habari: "how are you",
  asante: "thank you",
  tafadhali: "please"
};

export const REGION_VARIANTS = {
  kigali: {
    region: "Rwanda",
    mode: "Kigali conversational Kinyarwanda",
    markers: ["kigali", "murakoze", "cyane", "amakuru", "ndashaka", "bite", "ntacyo"],
    instruction: "Use fluent Kigali/Rwanda phrasing. Prefer warm, concise Kinyarwanda that sounds spoken, not textbook."
  },
  rwanda: {
    region: "Rwanda",
    mode: "Kinyarwanda mode",
    markers: ["muraho", "amakuru", "amakuru ki", "murakoze", "cyane", "ndashaka", "ntacyo", "mwaramutse"],
    instruction: "Use natural Rwanda Kinyarwanda. Keep local grammar, polite warmth, and idiomatic conversational wording."
  },
  burundi: {
    region: "Burundi",
    mode: "Kirundi mode",
    markers: ["amahoro", "amakuru meza", "ego", "cane", "mwaramutse", "urakoze cane", "ndabaramutsa"],
    instruction: "Use native Burundi Kirundi. Prefer Kirundi vocabulary and endings over Kinyarwanda lookalikes."
  },
  uganda: {
    region: "Uganda",
    mode: "Uganda-aware East African mode",
    markers: ["banange", "mukwano", "webale", "oli otya", "kampala", "naye", "luganda", "ssebo"],
    instruction: "Respect Uganda conversational cues. Preserve local honorifics and translate slang meaning naturally."
  },
  congo: {
    region: "Congo",
    mode: "Congo-aware mixed-language mode",
    markers: ["mbote", "ndeko", "kinshasa", "lubumbashi", "lingala", "merci mingi", "congo", "rdc"],
    instruction: "Respect Central African phrasing and natural French, Swahili, or Lingala-influenced wording when meaningful."
  },
  mixed: {
    region: "East/Central Africa",
    mode: "Swahili/French mixed mode",
    markers: ["habari", "asante", "sawa", "karibu", "tafadhali", "bonjour", "merci", "ca va", "salut"],
    instruction: "The speaker may code-switch between Swahili, French, and English. Translate the meaning naturally while preserving intentional local nuance."
  },
  neutral: {
    region: "General",
    mode: "neutral mode",
    markers: [],
    instruction: "Use natural, region-neutral wording for the target language."
  }
};

export const TARGET_LANGUAGE_INSTRUCTIONS = {
  rw: [
    "Use natural Rwanda Kinyarwanda as spoken by real people in Rwanda.",
    "Prefer conversational wording over literal textbook translation.",
    "Preserve respect, warmth, emotion, slang meaning, and local phrasing.",
    "Avoid English-style sentence structure when Kinyarwanda would phrase it differently."
  ],
  rn: [
    "Use native Burundi Kirundi, not Kinyarwanda with Kirundi spelling.",
    "Prefer Kirundi forms such as ego cane, cane, ni vyiza, mwaramutse, amakuru meza, and urakoze cane.",
    "For short acknowledgements or greetings, return a complete natural Kirundi phrase instead of a bare fragment.",
    "Avoid robotic, overly literal, or English-shaped Kirundi."
  ],
  sw: [
    "Use natural East/Central African Swahili phrasing.",
    "If the source mixes Swahili and French intentionally, preserve practical code-switching only when it sounds natural."
  ],
  luganda: [
    "Use natural conversational Luganda as spoken in Uganda.",
    "Preserve respect markers such as ssebo and nyabo when they carry social meaning."
  ],
  lg: [
    "Use natural conversational Luganda as spoken in Uganda.",
    "Preserve respect markers such as ssebo and nyabo when they carry social meaning."
  ],
  fr: [
    "If the source uses Central/East African French or Swahili-French code-switching, keep the translation natural for African French speakers."
  ]
};

export const ROBOTIC_PHRASES = [
  /^the translation is[:\s-]*/i,
  /^translated text[:\s-]*/i,
  /^here is the translation[:\s-]*/i,
  /^sure[,:\s-]*/i,
  /^of course[,:\s-]*/i,
  /\b(as an ai language model|i would translate this as)\b/gi
];

export const FILLER_WORDS = [
  "um",
  "uh",
  "er",
  "ah",
  "hmm",
  "you know",
  "i mean"
];
