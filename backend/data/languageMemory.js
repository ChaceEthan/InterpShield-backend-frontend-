import { LANGUAGE_NAMES as SHARED_LANGUAGE_NAMES } from "../../shared/languages.mjs";

export const LANGUAGE_NAMES = {
  ...SHARED_LANGUAGE_NAMES,
  luganda: "Luganda"
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
  es: {
    en: {
      hello: "hola",
      "hello everyone": "hola a todos",
      "how are you": "como estas?",
      "good morning": "buenos dias",
      "good evening": "buenas noches",
      "thank you": "gracias",
      "thank you very much": "muchas gracias",
      yes: "si",
      no: "no",
      okay: "vale",
      "no problem": "no hay problema",
      please: "por favor",
      "can you please give me your book": "Me puedes dar tu libro, por favor",
      "can you give me your book": "Me puedes dar tu libro",
      "i need help": "necesito ayuda",
      "i need your help now": "necesito tu ayuda ahora"
    }
  },
  fr: {
    en: {
      hello: "bonjour",
      "hello everyone": "bonjour a tous",
      "how are you": "comment allez-vous?",
      "good morning": "bonjour",
      "good evening": "bonsoir",
      "thank you": "merci",
      "thank you very much": "merci beaucoup",
      yes: "oui",
      no: "non",
      okay: "d'accord",
      "no problem": "pas de probleme",
      please: "s'il vous plait",
      "can you please give me your book": "Peux-tu me donner ton livre, s'il te plait",
      "can you give me your book": "Peux-tu me donner ton livre",
      "i need help": "j'ai besoin d'aide",
      "i need your help now": "j'ai besoin de ton aide maintenant"
    }
  },
  de: {
    en: {
      hello: "hallo",
      "hello everyone": "hallo zusammen",
      "how are you": "wie geht es dir?",
      "good morning": "guten morgen",
      "good evening": "guten abend",
      "thank you": "danke",
      "thank you very much": "vielen dank",
      yes: "ja",
      no: "nein",
      okay: "in ordnung",
      "no problem": "kein problem",
      please: "bitte",
      "can you please give me your book": "Kannst du mir bitte dein Buch geben",
      "can you give me your book": "Kannst du mir dein Buch geben",
      "i need help": "ich brauche Hilfe",
      "i need your help now": "ich brauche jetzt deine Hilfe"
    }
  },
  zh: {
    en: {
      hello: "你好",
      "hello everyone": "大家好",
      "how are you": "你好吗?",
      "good morning": "早上好",
      "good evening": "晚上好",
      "thank you": "谢谢",
      "thank you very much": "非常感谢",
      yes: "是",
      no: "不是",
      okay: "好的",
      "no problem": "没问题",
      please: "请",
      "can you please give me your book": "请把你的书给我",
      "can you give me your book": "你能把你的书给我吗",
      "i need help": "我需要帮助",
      "i need your help now": "我现在需要你的帮助"
    }
  },
  ja: {
    en: {
      hello: "こんにちは",
      "hello everyone": "みなさん、こんにちは",
      "how are you": "お元気ですか?",
      "good morning": "おはようございます",
      "good evening": "こんばんは",
      "thank you": "ありがとうございます",
      "thank you very much": "本当にありがとうございます",
      yes: "はい",
      no: "いいえ",
      okay: "大丈夫です",
      "no problem": "問題ありません",
      please: "お願いします",
      "can you please give me your book": "あなたの本を渡してもらえますか",
      "can you give me your book": "あなたの本を渡してもらえますか",
      "i need help": "助けが必要です",
      "i need your help now": "今あなたの助けが必要です"
    }
  },
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
      "ntacyo bitwaye": "no problem",
      "urashobora kumpa igitabo cyawe": "can you give me your book",
      "ndagusabye mfasha": "please help me",
      "nkeneye ubufasha": "i need help"
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
      "ni vyiza": "it is good",
      "urashobora kumpa igitabu cawe": "can you give me your book",
      "ndagusavye mfasha": "please help me",
      "nkeneye ubufasha": "i need help"
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
      hapana: "no",
      "unaweza kunipa kitabu chako": "can you give me your book",
      "tafadhali nisaidie": "please help me",
      "ninahitaji msaada": "i need help"
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
      "hello everyone": "muraho mwese",
      "good morning": "mwaramutse",
      "good evening": "mwiriwe",
      "thank you": "murakoze",
      "thank you very much": "murakoze cyane",
      yes: "yego",
      no: "oya",
      "i know": "ndabizi",
      problem: "ikibazo",
      "no problem": "ntacyo bitwaye",
      "can you please give me your book": "urashobora kumpa igitabo cyawe",
      okay: "ni byiza",
      "it is okay": "ni byiza"
    }
  },
  rn: {
    en: {
      "how are you": "amakuru meza?",
      hello: "amahoro",
      "hello everyone": "amahoro mwese",
      "good morning": "mwaramutse",
      "thank you": "urakoze cane",
      "thank you very much": "urakoze cane",
      yes: "ego cane",
      no: "oya",
      okay: "ni vyiza",
      "it is okay": "ni vyiza",
      "can you please give me your book": "urashobora kumpa igitabu cawe",
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
      "can you please give me your book": "unaweza kunipa kitabu chako",
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
      "hello everyone": "mwasuze mutya mwenna",
      "can you please give me your book": "osobola okumpa ekitabo kyo",
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
