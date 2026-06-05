export interface StrippedContent {
  original: string;
  bare: string;
  replacements: Array<{ original: string; placeholder: string }>;
}

const ENTITY_PLACEHOLDER = "[实体名]";

const BRAND_PATTERNS = [
  /[A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F0-9]{0,10}(?:牌|品牌|出品|官方|旗舰店)/g,
  /(?:用|买|选|推荐|喜欢|吃过|喝过|用过|试过)\s*[A-Za-z\u4E00-\u9FFF]{1,12}/g,
  /「[^」]{1,20}」/g,
  /《[^》]{1,20}》/g,
];

function heuristicEntityScan(raw: string): string[] {
  const found = new Set<string>();
  for (const pattern of BRAND_PATTERNS) {
    const matches = raw.matchAll(pattern);
    for (const m of matches) {
      found.add(m[0].trim());
    }
  }
  return [...found];
}

export function stripContext(raw: string, knownEntities?: string[]): StrippedContent {
  const entities = knownEntities ?? heuristicEntityScan(raw);
  const replacements: Array<{ original: string; placeholder: string }> = [];
  let bare = raw;

  for (const entity of entities) {
    if (!entity || entity.length < 2) continue;
    let index = 0;
    while (true) {
      const pos = bare.indexOf(entity, index);
      if (pos < 0) break;
      bare = bare.slice(0, pos) + ENTITY_PLACEHOLDER + bare.slice(pos + entity.length);
      replacements.push({ original: entity, placeholder: ENTITY_PLACEHOLDER });
      index = pos + ENTITY_PLACEHOLDER.length;
    }
  }

  return { original: raw, bare, replacements };
}
