export type * from "../types";

export type ZaiQuotaPayload = {
  error?: unknown;
  code?: unknown;
  success?: unknown;
  data?: unknown;
};

export type ZaiSubscriptionPayload = {
  error?: unknown;
  code?: unknown;
  success?: unknown;
  data?: unknown;
};

export interface ZaiPlanInfo {
  name: string;
  renewsAt?: string;
}

export type CodexBackendPayload = {
  plan_type?: unknown;
  rate_limit?: unknown;
  additional_rate_limits?: unknown;
  credits?: unknown;
  rate_limit_reset_credits?: unknown;
};

export type CommandCodeAccountPayload = {
  user?: unknown;
  org?: unknown;
};

export type CommandCodeCreditsPayload = {
  credits?: unknown;
  windowLimits?: unknown;
};

export type CommandCodeSubscriptionPayload = {
  data?: unknown;
};

export type CommandCodeUsageSummaryPayload = {
  totalCost?: unknown;
  totalCount?: unknown;
  totalTokens?: unknown;
  totalTokensIn?: unknown;
  totalTokensOut?: unknown;
};

export interface CommandCodeUsageBundle {
  account: CommandCodeAccountPayload;
  credits?: CommandCodeCreditsPayload;
  subscription?: CommandCodeSubscriptionPayload;
  usage?: CommandCodeUsageSummaryPayload;
}
