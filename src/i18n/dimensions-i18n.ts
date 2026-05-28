import { t } from "./index.js";
import {
	DIMENSIONS,
	type DimensionId,
	type DimensionDefinition,
	type DefensiveDimensionId,
	type OffensiveDimensionId,
} from "../execution/dimensions.js";

const NS = "dimensions";

export function getDimensionLabel(id: DimensionId): string {
	return t(`${id}.label`, { ns: NS });
}

export function getDimensionDescription(id: DimensionId): string {
	return t(`${id}.description`, { ns: NS });
}

export function getDimensionSentinelPoints(id: DimensionId): string[] {
	const points = t(`${id}.sentinelPoints`, { ns: NS, returnObjects: true });
	return Array.isArray(points) ? points : [];
}

export function getDimensionCriteria(
	id: DimensionId,
	level: "green" | "yellow" | "red",
): string {
	return t(`${id}.criteria.${level}`, { ns: NS });
}

export function getLocalizedDimension(id: DimensionId): DimensionDefinition {
	const base = DIMENSIONS[id];
	return {
		...base,
		label: getDimensionLabel(id),
		description: getDimensionDescription(id),
		sentinelPoints: getDimensionSentinelPoints(id),
		criteria: {
			green: getDimensionCriteria(id, "green"),
			yellow: getDimensionCriteria(id, "yellow"),
			red: getDimensionCriteria(id, "red"),
		},
	};
}

export function getLocalizedDimensions(): Record<DimensionId, DimensionDefinition> {
	const result = {} as Record<DimensionId, DimensionDefinition>;
	for (const id of Object.keys(DIMENSIONS) as DimensionId[]) {
		result[id] = getLocalizedDimension(id);
	}
	return result;
}

export function getDefensiveUITitle(): string {
	return t("ui.defensiveTitle", { ns: NS });
}

export function getOffensiveUITitle(): string {
	return t("ui.offensiveTitle", { ns: NS });
}

export function getDefensiveMandatoryLabel(): string {
	return t("ui.defensiveMandatory", { ns: NS });
}

export function getOffensiveOptionalLabel(): string {
	return t("ui.offensiveOptional", { ns: NS });
}

export function getStancePresetLabel(id: string): string {
	return t(`stancePresets.${id}`, { ns: NS });
}

export function getStancePerspective(id: string): string {
	return t(`stancePerspectives.${id}`, { ns: NS });
}
