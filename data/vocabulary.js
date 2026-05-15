const vocabulary = [
  {
    id: 29,
    word: "cause",
    pronunciation: "kɔːz",
    related: [
      { word: "causal", meaning: "원인과 결과의" },
      { word: "causality", meaning: "인과 관계" },
      { word: "casual", meaning: "격식 차리지 않는" },
    ],
    meanings: [
      {
        pos: "n.",
        definitions: [
          {
            korean: "원인",
            english: "Something that brings about an effect or a result",
            synonym: "reason",
            example: {
              en: ["The police are still trying to establish the ", "cause", " of the fire."],
              ko: "경찰은 아직도 화재의 원인을 밝히기 위해 노력하고 있다.",
            },
          },
          {
            korean: "대의명분",
            english: "A reason for an action or condition",
            synonym: "justification",
            example: {
              en: ["They are fighting for a ", "cause", " — the liberation of their people."],
              ko: "그들은 국민의 해방이라는 대의명분을 위해 싸우고 있다.",
            },
            subNote: { word: "liberation", meaning: "해방" },
          },
        ],
      },
      {
        pos: "v.",
        definitions: [
          {
            korean: "야기하다, 초래하다",
            english: "To serve as a cause or occasion of",
            synonym: "bring about",
            example: {
              en: ["The difficult driving conditions ", "caused", " several accidents."],
              ko: "어려운 운전 조건이 여러 사고를 일으켰다.",
            },
          },
        ],
      },
    ],
  },
];

export default vocabulary;
