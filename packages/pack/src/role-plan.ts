import type { AgentRole, TeamPack } from "@kit/core";

export interface RoleRules {
  requireSeller: boolean;
  requireBuilder: boolean;
  allowCombined: boolean;
}

export interface RolePlan {
  sellers: string[];
  builders: string[];
  specialists: string[];
  allowCombined: boolean;
}

export const DEFAULT_ROLE_RULES: RoleRules = {
  requireSeller: false,
  requireBuilder: true,
  allowCombined: true,
};

const SELLER_HINTS =
  /(sell|sales|seller|requirement|demand|market|customer|deliver|package|acceptance|销售|需求|市场|客户|交付|验收)/i;
const SPECIALIST_HINTS =
  /(review|reviewer|audit|verify|verifier|qa|test|security|cyber|ux|research|审计|评审|审核|质检|安全|体验|研究)/i;

export function inferAgentRole(
  id: string,
  description = "",
  isManager = false,
): AgentRole {
  if (isManager || id === "manager") {
    return "manager";
  }
  const text = `${id} ${description}`;
  if (SELLER_HINTS.test(text)) {
    return "seller";
  }
  if (SPECIALIST_HINTS.test(text)) {
    return "specialist";
  }
  return "builder";
}

export function resolveAgentRole(input: {
  id: string;
  description: string;
  isManager?: boolean;
  specRole?: AgentRole;
  frontmatterRole?: AgentRole;
}): AgentRole {
  if (input.isManager || input.id === "manager") {
    return "manager";
  }
  return (
    input.specRole ??
    input.frontmatterRole ??
    inferAgentRole(input.id, input.description, false)
  );
}

export function getRoleRules(pack: TeamPack): RoleRules {
  return {
    requireSeller:
      pack.roles?.requireSeller ?? DEFAULT_ROLE_RULES.requireSeller,
    requireBuilder:
      pack.roles?.requireBuilder ?? DEFAULT_ROLE_RULES.requireBuilder,
    allowCombined:
      pack.roles?.allowCombined ?? DEFAULT_ROLE_RULES.allowCombined,
  };
}

export function rolePlanForAgents(
  agents: ReadonlyMap<string, { role: AgentRole }>,
  allowCombined = true,
): RolePlan {
  const sellers: string[] = [];
  const builders: string[] = [];
  const specialists: string[] = [];
  for (const [id, agent] of agents) {
    if (agent.role === "seller") {
      sellers.push(id);
    } else if (agent.role === "specialist") {
      specialists.push(id);
    } else if (agent.role === "builder") {
      builders.push(id);
    }
  }
  return { sellers, builders, specialists, allowCombined };
}

export function validateRolePlan(input: {
  agents: ReadonlyMap<string, { role: AgentRole }>;
  rules: RoleRules;
  sellers: string[];
  builders: string[];
  specialists?: string[];
  allowCombined: boolean;
}): string[] {
  const errors: string[] = [];
  const sellers = unique(input.sellers);
  const builders = unique(input.builders);
  const specialists = unique(input.specialists ?? []);

  for (const id of [...sellers, ...builders, ...specialists]) {
    if (!input.agents.has(id)) {
      errors.push(`unknown agent: ${id}`);
    }
    if (input.agents.get(id)?.role === "manager") {
      errors.push(
        `manager cannot be assigned as seller/builder/specialist: ${id}`,
      );
    }
  }

  if (input.rules.requireSeller && sellers.length === 0) {
    errors.push("this Pack requires at least one Seller");
  }
  if (input.rules.requireBuilder && builders.length === 0) {
    errors.push("this Pack requires at least one Builder");
  }
  if (!input.allowCombined) {
    const overlap = sellers.filter((id) => builders.includes(id));
    if (overlap.length > 0) {
      errors.push(
        `this Pack does not allow one agent to be Seller and Builder: ${overlap.join(", ")}`,
      );
    }
  }

  return errors;
}

export function planAgents(plan: RolePlan): string[] {
  return unique([...plan.sellers, ...plan.builders, ...plan.specialists]);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
