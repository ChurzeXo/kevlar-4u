export interface SynergyRule {
  dimensions: string[];
  condition: 'ALL' | 'ANY';
  multiplier: number;
  upgradeLevel: boolean;
  label: string;
}

export interface SynergyResult {
  triggered: string[];
  overallMultiplier: number;
  levelUpgrades: Array<{
    dimension: string;
    from: string;
    to: string;
    reason: string;
  }>;
  details: Array<{
    rule: SynergyRule;
    matched: boolean;
  }>;
}

const SYNERGY_RULES: SynergyRule[] = [
  {
    dimensions: ['social_risk', 'network_culture_risk'],
    condition: 'ALL',
    multiplier: 2.5,
    upgradeLevel: true,
    label: '情绪传播 × 文化符号双触发',
  },
  {
    dimensions: ['context_distortion', 'network_culture_risk'],
    condition: 'ALL',
    multiplier: 2.0,
    upgradeLevel: true,
    label: '语境崩塌 × 暗语风险双触发',
  },
  {
    dimensions: ['legal_compliance', 'social_risk', 'context_distortion'],
    condition: 'ALL',
    multiplier: 3.0,
    upgradeLevel: true,
    label: '合规 × 社会风险 × 语境崩塌三向触发',
  },
  {
    dimensions: ['timing_risk'],
    condition: 'ANY',
    multiplier: 1.5,
    upgradeLevel: false,
    label: '时机窗口加成',
  },
];

export function calculateSynergy(
  dimensionLevels: Record<string, string>,
  extraFlags?: string[],
  customRules?: SynergyRule[],
): SynergyResult {
  const rules = customRules && customRules.length > 0 ? customRules : SYNERGY_RULES;
  const details: SynergyResult['details'] = [];
  const levelUpgrades: SynergyResult['levelUpgrades'] = [];
  let overallMultiplier = 1.0;

  for (const rule of rules) {
    let matched: boolean;

    if (rule.dimensions.includes('timing_risk')) {
      matched = (extraFlags ?? []).includes('timing_risk');
    } else if (rule.condition === 'ALL') {
      matched = rule.dimensions.every(
        (dim) => (dimensionLevels[dim] ?? '🟢') === '🔴' || (dimensionLevels[dim] ?? '🟢') === '🟡',
      );
    } else {
      matched = rule.dimensions.some(
        (dim) => (dimensionLevels[dim] ?? '🟢') === '🔴' || (dimensionLevels[dim] ?? '🟢') === '🟡',
      );
    }

    details.push({ rule, matched });
    if (matched) {
      overallMultiplier *= rule.multiplier;
      
      // 如果规则要求升级 level，将相关维度的 🟡 升级为 🔴
      if (rule.upgradeLevel) {
        for (const dim of rule.dimensions) {
          if (dim === 'timing_risk') continue; // timing_risk 不是实际维度
          const currentLevel = dimensionLevels[dim] ?? '🟢';
          if (currentLevel === '🟡') {
            levelUpgrades.push({
              dimension: dim,
              from: '🟡',
              to: '🔴',
              reason: rule.label,
            });
          }
        }
      }
    }
  }

  return {
    triggered: details.filter((d) => d.matched).map((d) => d.rule.label),
    overallMultiplier: Math.round(overallMultiplier * 10) / 10,
    levelUpgrades,
    details,
  };
}
